import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  buildT2000CreateJobTx,
  buildT2000DeliverTx,
  buildT2000ReleaseTx,
  buildT2000ScoreSetupTx,
  createSuiMainnetClient,
  freezeT2000Transaction,
  readT2000Score,
  t2000Config,
  validateT2000JobReceipt,
  validateT2000ScoreReceipt,
  type T2000JobExpectation,
} from '../app/lib/sui/t2000.ts';
import type { FrozenEscrowTransaction } from '../app/lib/sui/escrow.ts';

/**
 * A bounded mainnet smoke trial. Dry-run is the default. Execute mode writes
 * an atomic checkpoint before every signature and keeps the frozen bytes and
 * digest until that stage is reconciled, so a crash cannot create a second
 * funding job. The checkpoint contains public addresses, bytes, digests, and
 * object IDs only; it never contains keys or signatures.
 */
const MAX_FUNDING_ATOMIC = 100_000n;
const MAX_SUI_MIST = 50_000_000n;
const GAS_BUDGET_MIST = 5_000_000n;
const WORKER_TOP_UP_MIST = 15_000_000n;
const WORKER_REQUIRED_MIST = GAS_BUDGET_MIST * 2n;
const DEFAULT_AMOUNT_ATOMIC = 100_000n;
const DEFAULT_STATE_FILE = join(tmpdir(), 'ask2human', 't2000-trial-spend.json');
const TRIAL_REVIEW_WINDOW_MS = 60_000;
const TRIAL_REJECT_SPLIT_BPS = 5_000;

type TrialStage = 'topup' | 'score' | 'create' | 'deliver' | 'release' | 'done';
type TrialTerms = T2000JobExpectation;
type StageDigest = Partial<Record<Exclude<TrialStage, 'done'>, string>>;
type FrozenCheckpoint = {
  stage: Exclude<TrialStage, 'done'>;
  sender: string;
  digest: string;
  transactionBytesBase64: string;
};
type TrialState = {
  version: 2;
  fundingAtomic: string;
  suiMist: string;
  runs: number;
  updatedAt: string;
  stage: TrialStage;
  ownerAddress: string;
  workerAddress: string;
  amountAtomic: string;
  terms: TrialTerms;
  deliveryHash: string;
  needsTopUp: boolean;
  needsScore: boolean;
  jobId?: string;
  scoreId?: string;
  digests: StageDigest;
  frozen?: FrozenCheckpoint;
};

type TrialArgs = { execute: boolean; newRun: boolean; amountAtomic: bigint };

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // The deployment shell may already provide all variables.
  }
}

function parseAtomic(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Trial amount must be a positive decimal integer');
  return BigInt(value);
}

function parseArgs(): TrialArgs {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const newRun = args.includes('--new-run');
  const unknown = args.filter((arg) => arg !== '--execute' && arg !== '--new-run' && !arg.startsWith('--amount-atomic='));
  if (unknown.length) throw new Error('Unknown t2000 trial option');
  const amountArg = args.find((arg) => arg.startsWith('--amount-atomic='))?.slice('--amount-atomic='.length);
  const amountAtomic = amountArg === undefined ? DEFAULT_AMOUNT_ATOMIC : parseAtomic(amountArg);
  if (amountAtomic < 10_000n || amountAtomic > MAX_FUNDING_ATOMIC) {
    throw new Error('Trial amount must be between 10000 and 100000 USDC atomic units');
  }
  return { execute, newRun, amountAtomic };
}

function checkedPublicAddress(value: string, label: string): string {
  if (!isValidSuiAddress(value)) throw new Error(`${label} wallet address is invalid`);
  return normalizeSuiAddress(value);
}

function loadSigner(value: string | undefined, label: string): Ed25519Keypair {
  if (!value) throw new Error(`${label} wallet private key is not configured`);
  try {
    return Ed25519Keypair.fromSecretKey(value);
  } catch {
    throw new Error(`${label} wallet private key is invalid`);
  }
}

function briefHash(text: string): string {
  return `0x${createHash('sha256').update(text).digest('hex')}`;
}

async function readTrialState(path: string): Promise<TrialState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TrialState>;
    if (parsed.version !== 2) throw new Error('legacy or missing checkpoint version');
    const fundingAtomic = String(parsed.fundingAtomic);
    const suiMist = String(parsed.suiMist);
    if (!/^[0-9]+$/.test(fundingAtomic) || !/^[0-9]+$/.test(suiMist)) throw new Error('invalid cumulative totals');
    if (!['topup', 'score', 'create', 'deliver', 'release', 'done'].includes(String(parsed.stage))) throw new Error('invalid checkpoint stage');
    if (typeof parsed.ownerAddress !== 'string' || typeof parsed.workerAddress !== 'string' || typeof parsed.amountAtomic !== 'string') throw new Error('invalid checkpoint identities');
    if (!parsed.terms || typeof parsed.terms !== 'object' || typeof parsed.deliveryHash !== 'string') throw new Error('invalid checkpoint terms');
    const runs = parsed.runs;
    if (typeof runs !== 'number' || !Number.isSafeInteger(runs) || runs < 0) throw new Error('invalid run count');
    if (BigInt(fundingAtomic) > MAX_FUNDING_ATOMIC || BigInt(suiMist) > MAX_SUI_MIST) throw new Error('checkpoint exceeds trial caps');
    return parsed as TrialState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof Error && error.message === 'legacy or missing checkpoint version') {
      throw new Error('The existing t2000 trial state predates durable checkpoints; use a new T2000_TRIAL_STATE_FILE path.');
    }
    throw new Error('The t2000 trial checkpoint is invalid or unreadable.');
  }
}

async function writeTrialState(path: string, state: TrialState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function capGas(transaction: Transaction): Transaction {
  transaction.setGasBudget(GAS_BUDGET_MIST);
  return transaction;
}

function checkpointFrozen(checkpoint: FrozenCheckpoint): FrozenEscrowTransaction {
  return {
    digest: checkpoint.digest,
    transactionBytesBase64: checkpoint.transactionBytesBase64,
    transactionJson: '',
  };
}

async function finalizedDigest(client: SuiGrpcClient, digest: string): Promise<string | null> {
  try {
    const result = await client.getTransaction({ digest, include: { transaction: true, effects: true } });
    const transaction = (result as { $kind?: string; Transaction?: { digest?: string; effects?: { status?: { success?: boolean } } } }).Transaction;
    if (!transaction || (result as { $kind?: string }).$kind !== 'Transaction') return null;
    if (transaction.effects?.status?.success === false) throw new Error('checkpoint transaction failed on chain');
    if (transaction.effects?.status?.success === true) return transaction.digest ?? digest;
  } catch (error) {
    if (error instanceof Error && error.message === 'checkpoint transaction failed on chain') throw error;
    // A not-found response means the frozen bytes have not reached the node.
  }
  return null;
}

async function executeFrozen(client: SuiGrpcClient, signer: Ed25519Keypair, checkpoint: FrozenCheckpoint): Promise<string> {
  const sender = checkedPublicAddress(signer.toSuiAddress(), 'Signer');
  if (sender !== checkpoint.sender) throw new Error('The checkpoint signer does not match its frozen sender');
  const existing = await finalizedDigest(client, checkpoint.digest);
  if (existing) return existing;
  const bytes = fromBase64(checkpoint.transactionBytesBase64);
  try {
    const { signature } = await signer.signTransaction(bytes);
    const result = await client.executeTransaction({
      transaction: bytes,
      signatures: [signature],
      include: { transaction: true, effects: true, events: true },
    });
    if (result.$kind !== 'Transaction') throw new Error('mainnet returned a failed transaction result');
    const transaction = result.Transaction;
    if (transaction.digest !== checkpoint.digest || !transaction.effects?.status?.success) throw new Error('frozen transaction did not finalize with its expected digest');
    return transaction.digest;
  } catch (error) {
    // A crash after broadcast can surface as a duplicate or transport error;
    // reconcile the exact digest before reporting failure.
    const reconciled = await finalizedDigest(client, checkpoint.digest);
    if (reconciled) return reconciled;
    throw error instanceof Error ? new Error('The frozen trial transaction could not be finalized.') : new Error('The frozen trial transaction could not be finalized.');
  }
}

async function runStage<T>(input: {
  client: SuiGrpcClient;
  statePath: string;
  state: TrialState;
  stage: Exclude<TrialStage, 'done'>;
  sender: string;
  signer: Ed25519Keypair;
  build: () => Promise<Transaction> | Transaction;
  validate: (digest: string) => Promise<T>;
  next: TrialStage;
  applyResult?: (state: TrialState, result: T) => TrialState;
}): Promise<{ state: TrialState; result: T; digest: string }> {
  let state = input.state;
  let checkpoint = state.frozen;
  if (checkpoint && checkpoint.stage !== input.stage) throw new Error('The checkpoint contains an unrelated frozen stage.');
  if (!checkpoint) {
    const built = capGas(await input.build());
    const frozen = await freezeT2000Transaction(built, input.sender, input.client);
    checkpoint = { stage: input.stage, sender: input.sender, digest: frozen.digest, transactionBytesBase64: frozen.transactionBytesBase64 };
    state = { ...state, stage: input.stage, frozen: checkpoint, updatedAt: new Date().toISOString() };
    await writeTrialState(input.statePath, state);
  }
  const digest = await executeFrozen(input.client, input.signer, checkpoint);
  const result = await input.validate(digest);
  const digests = { ...state.digests, [input.stage]: digest } as StageDigest;
  state = { ...state, stage: input.next, frozen: undefined, digests, updatedAt: new Date().toISOString() };
  // Persist any prerequisite IDs together with the stage transition. A crash
  // after this write must leave a resumable checkpoint, so callers must not
  // need a second write to record a validated score or job object.
  if (input.applyResult) state = input.applyResult(state, result);
  await writeTrialState(input.statePath, state);
  return { state, result, digest };
}

function balanceValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error('The mainnet balance response was invalid');
}

loadDotEnv();
const { execute, newRun, amountAtomic } = parseArgs();
const statePath = resolve(process.env.T2000_TRIAL_STATE_FILE ?? DEFAULT_STATE_FILE);
const existingState = await readTrialState(statePath);
const config = t2000Config();

if (!execute) {
  console.log('t2000 trial dry-run: no transaction was built, signed, or broadcast.');
  console.log(`Planned task funding: ${amountAtomic.toString()} USDC atomic (cumulative cap ${MAX_FUNDING_ATOMIC.toString()}).`);
  console.log(`Cumulative checkpoint: ${existingState?.fundingAtomic ?? '0'} USDC atomic and ${existingState?.suiMist ?? '0'} MIST.`);
  console.log(`Execution requires --execute; use --new-run only after a completed checkpoint; checkpoint path: ${statePath}`);
  void config;
  process.exit(0);
}

const owner = loadSigner(process.env.OWNER_WALLET_PRIVATE, 'Owner');
const worker = loadSigner(process.env.WORKER_WALLET_PRIVATE, 'Worker');
const ownerAddress = checkedPublicAddress(owner.toSuiAddress(), 'Owner');
const workerAddress = checkedPublicAddress(worker.toSuiAddress(), 'Worker');
if (ownerAddress === workerAddress) throw new Error('Owner and worker wallets must be independent');
if (process.env.OWNER_WALLET_PUBLIC && checkedPublicAddress(process.env.OWNER_WALLET_PUBLIC, 'Owner public') !== ownerAddress) throw new Error('Owner private and public wallet values do not match');
if (process.env.WORKER_WALLET_PUBLIC && checkedPublicAddress(process.env.WORKER_WALLET_PUBLIC, 'Worker public') !== workerAddress) throw new Error('Worker private and public wallet values do not match');

let priorFunding = 0n;
let priorSui = 0n;
let priorRuns = 0;
if (existingState?.stage === 'done') {
  if (!newRun) {
    console.log(`t2000 trial already finalized job ${existingState.jobId ?? 'unknown'}; no second funding transaction was built.`);
    process.exit(0);
  }
  if (existingState.ownerAddress !== ownerAddress || existingState.workerAddress !== workerAddress) throw new Error('The completed trial checkpoint belongs to different wallets; use a separate state path.');
  priorFunding = BigInt(existingState.fundingAtomic);
  priorSui = BigInt(existingState.suiMist);
  priorRuns = existingState.runs;
} else if (existingState && newRun) {
  throw new Error('An active trial checkpoint must be resumed without --new-run.');
}
const resumableState = existingState?.stage === 'done' ? null : existingState;
if (resumableState && (resumableState.ownerAddress !== ownerAddress || resumableState.workerAddress !== workerAddress || resumableState.amountAtomic !== amountAtomic.toString())) {
  throw new Error('The active durable trial checkpoint belongs to different wallets or amount; resume it with matching arguments.');
}

const client = config.client;
let state: TrialState;
if (resumableState) {
  state = resumableState;
} else {
  // Complete all chain reads and reserve the whole lifecycle budget before
  // building or freezing any transaction. These reserves include the optional
  // owner SUI worker top-up and every gas budget in the trial.
  let workerBalance: bigint;
  let ownerBalance: bigint;
  let ownerUsdcBalance: bigint;
  let score: { id: string; exists: boolean };
  try {
    const [workerSui, ownerSui, ownerUsdc] = await Promise.all([
      client.getBalance({ owner: workerAddress, coinType: '0x2::sui::SUI' }),
      client.getBalance({ owner: ownerAddress, coinType: '0x2::sui::SUI' }),
      client.getBalance({ owner: ownerAddress, coinType: config.coinType }),
    ]);
    workerBalance = balanceValue(workerSui.balance.balance);
    ownerBalance = balanceValue(ownerSui.balance.balance);
    ownerUsdcBalance = balanceValue(ownerUsdc.balance.balance);
    score = await readT2000Score(client, workerAddress, config.scoreBoardId);
  } catch {
    throw new Error('The t2000 trial preflight could not read mainnet balances or score state.');
  }
  if (ownerUsdcBalance < amountAtomic) throw new Error('The owner USDC balance is below the requested trial amount.');
  const needsTopUp = workerBalance < WORKER_REQUIRED_MIST;
  const needsScore = !score.exists;
  const ownerRequiredSui = (needsTopUp ? WORKER_TOP_UP_MIST + GAS_BUDGET_MIST : 0n) + GAS_BUDGET_MIST * 2n;
  const workerRequiredSui = (needsScore ? GAS_BUDGET_MIST : 0n) + GAS_BUDGET_MIST;
  const reservedSui = (needsTopUp ? WORKER_TOP_UP_MIST + GAS_BUDGET_MIST : 0n)
    + (needsScore ? GAS_BUDGET_MIST : 0n)
    + GAS_BUDGET_MIST * 3n;
  if (ownerBalance < ownerRequiredSui) throw new Error('The owner SUI balance is below the complete trial gas and top-up reserve.');
  if (workerBalance + (needsTopUp ? WORKER_TOP_UP_MIST : 0n) < workerRequiredSui) throw new Error('The worker SUI balance cannot cover the complete trial gas reserve.');
  if (priorFunding + amountAtomic > MAX_FUNDING_ATOMIC || priorSui + reservedSui > MAX_SUI_MIST) throw new Error('The complete trial reserve exceeds its aggregate spend cap.');
  const terms: TrialTerms = {
    buyer: ownerAddress,
    seller: workerAddress,
    amountAtomic: amountAtomic.toString(),
    specHash: briefHash('Ask2Human t2000 bounded mainnet trial'),
    deliverByMs: Date.now() + 15 * 60 * 1000,
    reviewWindowMs: TRIAL_REVIEW_WINDOW_MS,
    rejectSplitBps: TRIAL_REJECT_SPLIT_BPS,
  };
  state = {
    version: 2,
    fundingAtomic: (priorFunding + amountAtomic).toString(),
    suiMist: (priorSui + reservedSui).toString(),
    runs: priorRuns,
    updatedAt: new Date().toISOString(),
    stage: needsTopUp ? 'topup' : needsScore ? 'score' : 'create',
    ownerAddress,
    workerAddress,
    amountAtomic: amountAtomic.toString(),
    terms,
    deliveryHash: briefHash('Ask2Human t2000 bounded trial delivery'),
    needsTopUp,
    needsScore,
    scoreId: score.exists ? score.id : undefined,
    digests: {},
  };
  await writeTrialState(statePath, state);
}

if (state.stage === 'topup') {
  const topup = await runStage({
    client, statePath, state, stage: 'topup', sender: ownerAddress, signer: owner,
    build: () => {
      const transaction = new Transaction();
      const [coin] = transaction.splitCoins(transaction.gas, [WORKER_TOP_UP_MIST]);
      transaction.transferObjects([coin], transaction.pure.address(workerAddress));
      return transaction;
    },
    validate: async () => undefined,
    next: state.needsScore ? 'score' : 'create',
  });
  state = topup.state;
}

if (state.stage === 'score') {
  if (!state.needsScore) {
    state = { ...state, stage: 'create', updatedAt: new Date().toISOString() };
    await writeTrialState(statePath, state);
  } else {
    const scoreStage = await runStage({
      client, statePath, state, stage: 'score', sender: workerAddress, signer: worker,
      build: () => buildT2000ScoreSetupTx(workerAddress, config.scoreBoardId),
      validate: async (digest) => {
        const receipt = await validateT2000ScoreReceipt({ client, digest, expectedSender: workerAddress, agent: workerAddress, boardId: config.scoreBoardId });
        return receipt.scoreId;
      },
      next: 'create',
      applyResult: (nextState, scoreId) => ({ ...nextState, scoreId }),
    });
    state = scoreStage.state;
  }
}

if (state.stage === 'create') {
  if (state.jobId) {
    state = { ...state, stage: 'deliver', updatedAt: new Date().toISOString() };
    await writeTrialState(statePath, state);
  } else {
    const createdStage = await runStage({
      client, statePath, state, stage: 'create', sender: ownerAddress, signer: owner,
      build: () => buildT2000CreateJobTx(state.terms, client),
      validate: async (digest) => validateT2000JobReceipt({ client, packageId: config.packageId, digest, expectedSender: ownerAddress, expectedState: 'funded', expected: state.terms }),
      next: 'deliver',
      applyResult: (nextState, receipt) => ({ ...nextState, jobId: receipt.jobId }),
    });
    state = createdStage.state;
  }
}

if (state.stage === 'deliver') {
  if (!state.jobId || !state.scoreId) throw new Error('The durable trial checkpoint is missing its job or score object ID.');
  const deliveredStage = await runStage({
    client, statePath, state, stage: 'deliver', sender: workerAddress, signer: worker,
    build: () => buildT2000DeliverTx(state.jobId!, state.deliveryHash, state.scoreId!),
    validate: async (digest) => validateT2000JobReceipt({ client, packageId: config.packageId, digest, expectedSender: workerAddress, expectedState: 'delivered', expected: state.terms, jobId: state.jobId, expectedDeliveryHash: state.deliveryHash }),
    next: 'release',
  });
  state = deliveredStage.state;
}

if (state.stage === 'release') {
  if (!state.jobId || !state.scoreId) throw new Error('The durable trial checkpoint is missing its job or score object ID.');
  const releasedStage = await runStage({
    client, statePath, state, stage: 'release', sender: ownerAddress, signer: owner,
    build: () => buildT2000ReleaseTx(state.jobId!, state.scoreId!),
    validate: async (digest) => validateT2000JobReceipt({ client, packageId: config.packageId, digest, expectedSender: ownerAddress, expectedState: 'released', expected: state.terms, jobId: state.jobId, expectedDeliveryHash: state.deliveryHash }),
    next: 'done',
    applyResult: (nextState) => ({ ...nextState, runs: nextState.runs + 1 }),
  });
  state = releasedStage.state;
}

console.log(`t2000 mainnet trial finalized one ${state.amountAtomic} atomic USDC task.`);
console.log(`Owner wallet: ${state.ownerAddress}`);
console.log(`Worker wallet: ${state.workerAddress}`);
console.log(`Job: ${state.jobId ?? 'unknown'}`);
console.log(`Cumulative reserved funding: ${state.fundingAtomic} atomic USDC; reserved SUI gas/transfers: ${state.suiMist} MIST.`);
