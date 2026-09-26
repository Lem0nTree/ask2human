import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import {
  A2A_ESCROW_FEE_CONFIG_ID,
  ESCROW_JOB_TYPE_MARKER,
  MAINNET_A2A_ESCROW_PACKAGE_ID,
  MAINNET_A2A_ESCROW_LATEST_PACKAGE_ID,
  MAINNET_A2A_SCORE_BOARD_ID,
  USDC_DECIMALS,
  USDC_TYPE,
  buildCreateEmptyScoreTx,
  buildCreateJobTx,
  buildDeliverJobTx,
  buildRejectJobTx,
  buildRefundJobTx,
  buildReleaseJobTx,
  buildSubmitFirstReviewTx,
  buildSubmitReviewTx,
  deriveAgentScoreId,
  getAgentScore,
  getJob,
  resolveCreatedObjectId,
} from '@t2000/sdk';
import type { Job } from '@t2000/sdk';
import { normalizeStructTag, normalizeSuiAddress, isValidSuiAddress, isValidTransactionDigest } from '@mysten/sui/utils';
import { resolveEscrowTxForSigning, type FrozenEscrowTransaction } from './escrow';

const DEFAULT_MAINNET_GRPC_URL = 'https://fullnode.mainnet.sui.io:443';
const MAX_U64 = (1n << 64n) - 1n;
const MAX_JOB_ATOMIC = 100_000_000n * 1_000_000n;

export const T2000_ASSET = 'USDC' as const;
export const T2000_NETWORK = 'mainnet' as const;
export const T2000_DECIMALS = USDC_DECIMALS;
export const T2000_COIN_TYPE = USDC_TYPE;
/** Immutable package anchor used by the on-chain Job type.  Transaction call
 * targets are upgraded separately inside the official SDK. */
export const T2000_DEFAULT_PACKAGE_ID = MAINNET_A2A_ESCROW_PACKAGE_ID;
export const T2000_LATEST_PACKAGE_ID = MAINNET_A2A_ESCROW_LATEST_PACKAGE_ID;
export const T2000_DEFAULT_FEE_CONFIG_ID = A2A_ESCROW_FEE_CONFIG_ID;
export const T2000_DEFAULT_SCORE_BOARD_ID = MAINNET_A2A_SCORE_BOARD_ID;
/** Mainnet Agent-ID registry used by reject_v2.  It is shared and read-only. */
export const T2000_DEFAULT_REGISTRY_ID = '0xf41683aa9f4c121f34e4082c35180b0efdbd6d5293e3c88b1bcfa45ddf5c4119';
export const T2000_JOB_TYPE_MARKER = ESCROW_JOB_TYPE_MARKER;

export type T2000Client = SuiGrpcClient;
type SuiCoreClient = SuiGrpcClient;

export type T2000Config = {
  network: typeof T2000_NETWORK;
  asset: typeof T2000_ASSET;
  decimals: typeof T2000_DECIMALS;
  coinType: typeof T2000_COIN_TYPE;
  packageId: string;
  feeConfigId: string;
  scoreBoardId: string;
  /** Registry is only required by rejection; funding and settlement do not
   * need an application-specific registry object. */
  registryId: string | null;
  client: T2000Client;
};

export type T2000Terms = {
  buyer: string;
  seller: string;
  amountAtomic: string;
  specHash: string;
  deliverByMs: number;
  reviewWindowMs: number;
  rejectSplitBps: number;
};

export type T2000JobExpectation = {
  buyer: string;
  seller: string;
  amountAtomic: string;
  specHash: string;
  deliverByMs: number;
  reviewWindowMs: number;
  rejectSplitBps: number;
};

export type T2000Receipt = {
  digest: string;
  sender: string;
  jobId: string;
  job: Job;
};

export function createSuiMainnetClient(): T2000Client {
  return new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: process.env.SUI_GRPC_URL ?? process.env.SUI_RPC_URL ?? DEFAULT_MAINNET_GRPC_URL,
  });
}

function checkedAddress(value: string, label: string): string {
  if (!isValidSuiAddress(value)) throw new TypeError(`${label} must be a Sui address`);
  return normalizeSuiAddress(value);
}

function checkedAtomic(value: string, label = 'amountAtomic'): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${label} must be an unsigned decimal integer string`);
  const atomic = BigInt(value);
  if (atomic === 0n || atomic > MAX_U64) throw new RangeError(`${label} is outside the allowed u64 range`);
  if (atomic > MAX_JOB_ATOMIC) throw new RangeError(`${label} exceeds the t2000 job maximum`);
  return atomic;
}

/** Convert atomic USDC without allowing a floating point value to round. */
export function atomicToUsdc(amountAtomic: string): number {
  const atomic = checkedAtomic(amountAtomic);
  const whole = atomic / 1_000_000n;
  const fraction = atomic % 1_000_000n;
  const amount = Number(whole) + Number(fraction) / 1_000_000;
  if (!Number.isSafeInteger(Number(atomic)) || !Number.isFinite(amount)) {
    throw new RangeError('USDC amount cannot be represented safely by the SDK');
  }
  return amount;
}

export function normalizeT2000Hash(value: string): string {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new TypeError('t2000 hashes must be exactly 32 bytes');
  return `0x${normalized.toLowerCase()}`;
}

function checkedTerms(input: T2000Terms) {
  const buyer = checkedAddress(input.buyer, 'buyer');
  const seller = checkedAddress(input.seller, 'seller');
  if (buyer === seller) throw new TypeError('buyer and seller must be different wallets');
  const amountAtomic = checkedAtomic(input.amountAtomic);
  if (amountAtomic < 10_000n) throw new RangeError('t2000 jobs require at least 0.01 USDC');
  if (!Number.isSafeInteger(input.deliverByMs) || input.deliverByMs <= Date.now()) throw new RangeError('deliverByMs must be a future epoch-millisecond integer');
  if (!Number.isSafeInteger(input.reviewWindowMs) || input.reviewWindowMs < 0 || input.reviewWindowMs > 2_592_000_000) throw new RangeError('reviewWindowMs is outside the t2000 range');
  if (!Number.isInteger(input.rejectSplitBps) || input.rejectSplitBps < 0 || input.rejectSplitBps > 10_000) throw new RangeError('rejectSplitBps must be between 0 and 10000');
  return {
    buyer,
    seller,
    amountAtomic,
    specHash: normalizeT2000Hash(input.specHash),
    deliverByMs: input.deliverByMs,
    reviewWindowMs: input.reviewWindowMs,
    rejectSplitBps: input.rejectSplitBps,
  };
}

/** Read immutable t2000 mainnet configuration. Configuration never falls back
 * to a testnet package or coin. */
export function t2000Config(): T2000Config {
  const network = process.env.SUI_NETWORK ?? 'mainnet';
  if (network !== T2000_NETWORK) throw new Error('t2000 payments require SUI_NETWORK=mainnet');
  const coinType = process.env.T2000_COIN_TYPE ?? USDC_TYPE;
  if (coinType !== USDC_TYPE) throw new Error('t2000 payments require the canonical mainnet USDC type');
  const configuredPackageId = process.env.T2000_ESCROW_PACKAGE_ID ?? MAINNET_A2A_ESCROW_PACKAGE_ID;
  const feeConfigId = process.env.T2000_FEE_CONFIG_ID ?? A2A_ESCROW_FEE_CONFIG_ID;
  const scoreBoardId = process.env.T2000_SCORE_BOARD_ID ?? process.env.A2A_SCORE_BOARD_ID ?? MAINNET_A2A_SCORE_BOARD_ID;
  const registryId = process.env.T2000_AGENT_REGISTRY_ID ?? process.env.A2A_AGENT_REGISTRY_ID ?? T2000_DEFAULT_REGISTRY_ID;
  const normalizedConfiguredPackage = normalizeSuiAddress(configuredPackageId);
  if (normalizedConfiguredPackage !== normalizeSuiAddress(MAINNET_A2A_ESCROW_PACKAGE_ID)
      && normalizedConfiguredPackage !== normalizeSuiAddress(MAINNET_A2A_ESCROW_LATEST_PACKAGE_ID)) {
    throw new Error('t2000 Job package and configured package do not match');
  }
  checkedAddress(feeConfigId, 'feeConfigId');
  checkedAddress(scoreBoardId, 'scoreBoardId');
  if (registryId) checkedAddress(registryId, 'registryId');
  return {
    network: T2000_NETWORK,
    asset: T2000_ASSET,
    decimals: T2000_DECIMALS,
    coinType: USDC_TYPE,
    // Receipt/type validation always uses the original immutable Job package,
    // even when an operator still has the latest upgrade in configuration.
    packageId: normalizeSuiAddress(MAINNET_A2A_ESCROW_PACKAGE_ID),
    feeConfigId: normalizeSuiAddress(feeConfigId),
    scoreBoardId: normalizeSuiAddress(scoreBoardId),
    registryId: registryId ? normalizeSuiAddress(registryId) : null,
    client: createSuiMainnetClient(),
  };
}

/** Read the fee snapshot source used by create().  A build must quote this
 * value before freezing bytes; the Job later snapshots the same value. */
export async function readT2000FeeBps(client: T2000Client, feeConfigId: string): Promise<number> {
  const response = await client.core.getObject({ objectId: checkedAddress(feeConfigId, 'feeConfigId'), include: { json: true } });
  const json = response.object?.json as Record<string, unknown> | null | undefined;
  const value = json?.fee_bps;
  const feeBps = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 1_000) throw new Error('t2000 FeeConfig fee_bps is unavailable or invalid');
  return feeBps;
}

/** Resolve Agent-ID membership from the authoritative shared registry.  The
 * registry stores a `Table<address, AgentRecord>` in `Registry.agents`; the
 * table UID (`agents.id`) is the dynamic-field parent.  Listing fields from
 * the Registry UID itself would inspect unrelated state and can select the
 * wrong reject branch. */
export async function isT2000RegisteredAgent(client: T2000Client, registryId: string, agent: string): Promise<boolean> {
  const registryObjectId = checkedAddress(registryId, 'registryId');
  const response = await client.core.getObject({ objectId: registryObjectId, include: { json: true } });
  const registryJson = response.object?.json;
  const agents = registryJson && typeof registryJson === 'object'
    ? (registryJson as Record<string, unknown>).agents
    : undefined;
  const tableId = agents && typeof agents === 'object'
    ? (agents as Record<string, unknown>).id
    : undefined;
  if (typeof tableId !== 'string') throw new Error('t2000 Agent-ID registry agents table ID is unavailable');
  const parentId = checkedAddress(tableId, 'registry agents table ID');
  const wanted = bcs.Address.serialize(checkedAddress(agent, 'agent')).toBytes();
  let cursor: string | null = null;
  do {
    const page = await client.core.listDynamicFields({ parentId, limit: 100, cursor });
    if (!Array.isArray(page.dynamicFields) || typeof page.hasNextPage !== 'boolean' || (page.cursor !== null && typeof page.cursor !== 'string')) {
      throw new Error('t2000 Agent-ID registry dynamic-field response is malformed');
    }
    for (const field of page.dynamicFields) {
      const bytes = field.name?.bcs;
      if (!(bytes instanceof Uint8Array)) throw new Error('t2000 Agent-ID registry dynamic-field key is malformed');
      if (bytes.length === wanted.length && bytes.every((value, index) => value === wanted[index])) return true;
    }
    if (page.hasNextPage && !page.cursor) throw new Error('t2000 Agent-ID registry pagination cursor is missing');
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return false;
}

export async function buildT2000CreateJobTx(input: T2000Terms, client: T2000Client): Promise<Transaction> {
  const terms = checkedTerms(input);
  return buildCreateJobTx({
    client: client as SuiCoreClient,
    buyer: terms.buyer,
    terms: {
      seller: terms.seller,
      amountUsdc: atomicToUsdc(terms.amountAtomic.toString()),
      specHash: terms.specHash,
      deliverByMs: terms.deliverByMs,
      reviewWindowMs: terms.reviewWindowMs,
      rejectSplitBps: terms.rejectSplitBps,
    },
  });
}

export function buildT2000DeliverTx(jobId: string, deliveryHash: string, sellerScoreId: string): Transaction {
  return buildDeliverJobTx(checkedAddress(jobId, 'jobId'), normalizeT2000Hash(deliveryHash), { sellerScoreId: checkedAddress(sellerScoreId, 'sellerScoreId') });
}

export function buildT2000ReleaseTx(jobId: string, sellerScoreId: string): Transaction {
  return buildReleaseJobTx(checkedAddress(jobId, 'jobId'), { sellerScoreId: checkedAddress(sellerScoreId, 'sellerScoreId') });
}

export function buildT2000RejectTx(jobId: string, sellerScoreId: string, registryId: string, buyerScoreId?: string): Transaction {
  return buildRejectJobTx(checkedAddress(jobId, 'jobId'), {
    sellerScoreId: checkedAddress(sellerScoreId, 'sellerScoreId'),
    registryId: checkedAddress(registryId, 'registryId'),
    ...(buyerScoreId ? { buyerScoreId: checkedAddress(buyerScoreId, 'buyerScoreId') } : {}),
  });
}

export function buildT2000RefundTx(jobId: string, sellerScoreId: string): Transaction {
  return buildRefundJobTx(checkedAddress(jobId, 'jobId'), { sellerScoreId: checkedAddress(sellerScoreId, 'sellerScoreId') });
}

export function buildT2000ScoreSetupTx(agent: string, boardId: string): Transaction {
  return buildCreateEmptyScoreTx({ agent: checkedAddress(agent, 'agent'), boardId: checkedAddress(boardId, 'boardId') });
}

export function buildT2000RatingTx(jobId: string, stars: number, scoreId: string | null, boardId: string): Transaction {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new RangeError('rating stars must be an integer from 1 to 5');
  const id = checkedAddress(jobId, 'jobId');
  return scoreId
    ? buildSubmitReviewTx({ scoreId: checkedAddress(scoreId, 'scoreId'), jobId: id, stars })
    : buildSubmitFirstReviewTx({ jobId: id, stars, boardId: checkedAddress(boardId, 'boardId') });
}

export async function freezeT2000Transaction(transaction: Transaction, sender: string, client: T2000Client): Promise<FrozenEscrowTransaction> {
  return resolveEscrowTxForSigning(transaction, { sender: checkedAddress(sender, 'sender'), client });
}

function asBytes(value: unknown): number[] {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) return value as number[];
  return [];
}

function bytesToHex(value: unknown): string {
  return `0x${asBytes(value).map((item) => item.toString(16).padStart(2, '0')).join('')}`;
}

function atomicFromJob(job: Job): string {
  const amount = job.amountUsdc;
  if (!Number.isSafeInteger(Math.round(amount * 1_000_000))) throw new Error('t2000 job amount is not safely representable');
  return String(Math.round(amount * 1_000_000));
}

async function validateJobObject(client: T2000Client, jobId: string, expectedPackageId: string): Promise<Job> {
  const response = await client.core.getObject({ objectId: jobId, include: { json: true } });
  const type = response.object?.type;
  if (typeof type !== 'string') throw new Error('t2000 receipt did not resolve a typed Job object');
  const expectedType = `${normalizeSuiAddress(expectedPackageId)}::escrow::Job<${normalizeStructTag(USDC_TYPE)}>`;
  if (normalizeStructTag(type) !== normalizeStructTag(expectedType)) throw new Error('t2000 receipt Job package or asset type did not match mainnet USDC');
  const job = await getJob(client as SuiCoreClient, jobId);
  if (atomicFromJob(job) === '0') throw new Error('t2000 receipt Job amount was zero');
  return job;
}

/** Read a typed mainnet-USDC Job for timeout checks and action preparation.
 * The object type is checked before the SDK parser is trusted. */
export async function readT2000Job(client: T2000Client, jobId: string, packageId: string): Promise<Job> {
  return validateJobObject(client, checkedAddress(jobId, 'jobId'), checkedAddress(packageId, 'packageId'));
}

function receiptSender(result: unknown): string | undefined {
  const tx = (result as { Transaction?: { transaction?: { sender?: string }; digest?: string } })?.Transaction;
  return tx?.transaction?.sender;
}

/** Wait for a finalized transaction, recover the created Job, and bind every
 * immutable term before the caller changes its database state. */
export async function validateT2000JobReceipt(input: {
  client: T2000Client;
  packageId: string;
  digest: string;
  expectedSender: string;
  expectedState: Job['state'];
  expected: T2000JobExpectation;
  /** For mutations of an existing Job, bind the receipt to that exact object.
   * Creation receipts omit this and recover the created Job from effects. */
  jobId?: string;
  expectedDeliveryHash?: string;
}): Promise<T2000Receipt> {
  if (!isValidTransactionDigest(input.digest)) throw new TypeError('digest must be a valid Sui transaction digest');
  const result = await input.client.waitForTransaction({
    digest: input.digest,
    include: { transaction: true, effects: true, events: true },
  });
  const tx = (result as { $kind?: string; Transaction?: { status?: { success?: boolean }; digest?: string } }).Transaction;
  if (!tx || (result as { $kind?: string }).$kind !== 'Transaction' || tx.status?.success !== true) throw new Error('t2000 transaction did not succeed');
  if (tx.digest && tx.digest !== input.digest) throw new Error('t2000 receipt digest mismatch');
  const sender = receiptSender(result);
  if (!sender || checkedAddress(sender, 'transaction sender') !== checkedAddress(input.expectedSender, 'expected sender')) throw new Error('t2000 receipt sender mismatch');
  const jobId = input.jobId
    ? checkedAddress(input.jobId, 'jobId')
    : await resolveCreatedObjectId(input.client, input.digest, T2000_JOB_TYPE_MARKER);
  if (!jobId) throw new Error('t2000 receipt did not create or touch a Job object');
  const job = await validateJobObject(input.client, jobId, input.packageId);
  const expected = input.expected;
  if (checkedAddress(job.buyer, 'job buyer') !== checkedAddress(expected.buyer, 'expected buyer')) throw new Error('t2000 Job buyer mismatch');
  if (checkedAddress(job.seller, 'job seller') !== checkedAddress(expected.seller, 'expected seller')) throw new Error('t2000 Job seller mismatch');
  if (atomicFromJob(job) !== checkedAtomic(expected.amountAtomic).toString()) throw new Error('t2000 Job amount mismatch');
  if (normalizeT2000Hash(job.specHash) !== normalizeT2000Hash(expected.specHash)) throw new Error('t2000 Job spec hash mismatch');
  if (job.deliverByMs !== expected.deliverByMs || job.reviewWindowMs !== expected.reviewWindowMs || job.rejectSplitBps !== expected.rejectSplitBps) throw new Error('t2000 Job terms mismatch');
  if (job.state !== input.expectedState) throw new Error(`t2000 Job state ${job.state} did not match ${input.expectedState}`);
  if (input.expectedDeliveryHash && normalizeT2000Hash(job.deliveryHash ?? '') !== normalizeT2000Hash(input.expectedDeliveryHash)) throw new Error('t2000 delivery hash mismatch');
  return { digest: input.digest, sender: checkedAddress(sender, 'transaction sender'), jobId, job };
}

export async function readT2000Score(client: T2000Client, agent: string, boardId: string): Promise<{ id: string; exists: boolean }> {
  const id = deriveAgentScoreId(checkedAddress(agent, 'agent'), checkedAddress(boardId, 'boardId'));
  const score = await getAgentScore(client as SuiCoreClient, checkedAddress(agent, 'agent'), checkedAddress(boardId, 'boardId'));
  return { id, exists: !!score };
}

export async function validateT2000ScoreReceipt(input: { client: T2000Client; digest: string; expectedSender: string; agent: string; boardId: string }) {
  if (!isValidTransactionDigest(input.digest)) throw new TypeError('digest must be a valid Sui transaction digest');
  const result = await input.client.waitForTransaction({ digest: input.digest, include: { transaction: true, effects: true } });
  const tx = (result as { $kind?: string; Transaction?: { status?: { success?: boolean }; digest?: string } }).Transaction;
  if (!tx || (result as { $kind?: string }).$kind !== 'Transaction' || tx.status?.success !== true) throw new Error('t2000 score transaction did not succeed');
  const sender = receiptSender(result);
  const expectedSender = checkedAddress(input.expectedSender, 'expected sender');
  if (!sender || checkedAddress(sender, 'transaction sender') !== expectedSender) throw new Error('t2000 score receipt sender mismatch');
  const score = await readT2000Score(input.client, input.agent, input.boardId);
  if (!score.exists) throw new Error('t2000 score object was not created');
  return { digest: input.digest, sender: expectedSender, scoreId: score.id };
}

export async function validateT2000RatingReceipt(input: { client: T2000Client; digest: string; expectedSender: string; jobId: string; packageId: string }) {
  if (!isValidTransactionDigest(input.digest)) throw new TypeError('digest must be a valid Sui transaction digest');
  const result = await input.client.waitForTransaction({ digest: input.digest, include: { transaction: true, effects: true } });
  const tx = (result as { $kind?: string; Transaction?: { status?: { success?: boolean }; digest?: string } }).Transaction;
  if (!tx || (result as { $kind?: string }).$kind !== 'Transaction' || tx.status?.success !== true) throw new Error('t2000 rating transaction did not succeed');
  const sender = receiptSender(result);
  if (!sender || checkedAddress(sender, 'transaction sender') !== checkedAddress(input.expectedSender, 'expected sender')) throw new Error('t2000 rating receipt sender mismatch');
  const response = await input.client.core.getObject({ objectId: checkedAddress(input.jobId, 'jobId'), include: { json: true } });
  const type = response.object?.type;
  if (typeof type !== 'string' || normalizeStructTag(type) !== normalizeStructTag(`${normalizeSuiAddress(input.packageId)}::escrow::Job<${USDC_TYPE}>`)) throw new Error('t2000 rating Job asset or package mismatch');
  const job = await getJob(input.client as SuiCoreClient, input.jobId);
  if (!['released', 'rejected'].includes(job.state)) throw new Error('t2000 rating requires a settled Job');
  return { digest: input.digest, sender: checkedAddress(sender, 'transaction sender'), jobId: input.jobId, state: job.state };
}
