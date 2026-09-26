import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import {
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeSuiAddress,
  toBase64,
} from '@mysten/sui/utils';

const MODULE = 'job_escrow';
const MAX_U64 = (1n << 64n) - 1n;
const DEFAULT_TESTNET_GRPC_URL = 'https://fullnode.testnet.sui.io:443';

export type EscrowHash = Uint8Array | `0x${string}`;
export type EscrowReceiptKind = 'created' | 'submitted' | 'released' | 'refunded';

export interface BuildCreateAndFundTxInput {
  packageId: string;
  worker: string;
  briefHash: EscrowHash;
  deadlineMs: string;
  amountMist: string;
}

export interface BuildSubmitTxInput {
  packageId: string;
  jobId: string;
  commitmentHash: EscrowHash;
}

export interface BuildJobTxInput {
  packageId: string;
  jobId: string;
}

export interface ValidateEscrowReceiptInput {
  packageId: string;
  digest: string;
  expectedKind: EscrowReceiptKind;
  expectedActor: string;
}

export interface ResolveEscrowTxInput {
  sender: string;
  client?: SuiGrpcClient;
}

export interface FrozenEscrowTransaction {
  digest: string;
  transactionBytesBase64: string;
  transactionJson: string;
}

export interface ValidatedEscrowReceipt {
  kind: EscrowReceiptKind;
  digest: string;
  sender: string;
  jobId: string;
  funder?: string;
  worker?: string;
  amountMist?: string;
  briefHash?: string;
  deadlineMs?: string;
  commitmentHash?: string;
}

export function createSuiTestnetClient(): SuiGrpcClient {
  return new SuiGrpcClient({
    network: 'testnet',
    baseUrl: process.env.SUI_RPC_URL ?? DEFAULT_TESTNET_GRPC_URL,
  });
}

const createdEvent = bcs.struct('JobCreated', {
  job_id: bcs.Address,
  funder: bcs.Address,
  worker: bcs.Address,
  amount_mist: bcs.u64(),
  brief_hash: bcs.vector(bcs.u8()),
  deadline_ms: bcs.u64(),
});

const submittedEvent = bcs.struct('WorkSubmitted', {
  job_id: bcs.Address,
  funder: bcs.Address,
  worker: bcs.Address,
  commitment_hash: bcs.vector(bcs.u8()),
  submitted_at_ms: bcs.u64(),
});

const settledEvent = (name: string) => bcs.struct(name, {
  job_id: bcs.Address,
  funder: bcs.Address,
  worker: bcs.Address,
  amount_mist: bcs.u64(),
});

const releasedEvent = settledEvent('JobReleased');
const refundedEvent = settledEvent('JobRefunded');

function checkedAddress(address: string, label: string): string {
  if (!isValidSuiAddress(address)) {
    throw new TypeError(`${label} must be a 32-byte Sui address`);
  }

  return normalizeSuiAddress(address);
}

function checkedU64(value: string, label: string, mustBePositive = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be an unsigned decimal integer string`);
  }

  const parsed = BigInt(value);
  if (parsed > MAX_U64 || (mustBePositive && parsed === 0n)) {
    throw new RangeError(`${label} is outside the allowed u64 range`);
  }

  return parsed;
}

function checkedHash(value: EscrowHash, label: string): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = new Uint8Array(value);
  } else if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    bytes = Uint8Array.from(value.slice(2).match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
  } else {
    throw new TypeError(`${label} must be 32 bytes or a 0x-prefixed 32-byte hex string`);
  }

  if (bytes.length !== 32) {
    throw new TypeError(`${label} must be exactly 32 bytes`);
  }

  return bytes;
}

function checkedJobId(jobId: string): string {
  return checkedAddress(jobId, 'jobId');
}

function escrowCall(packageId: string, functionName: string): string {
  return `${checkedAddress(packageId, 'packageId')}::${MODULE}::${functionName}`;
}

/** Build a wallet-signable transaction. The caller sets its sender before serialization. */
export function buildCreateAndFundTx(input: BuildCreateAndFundTxInput): Transaction {
  const amountMist = checkedU64(input.amountMist, 'amountMist', true);
  const deadlineMs = checkedU64(input.deadlineMs, 'deadlineMs', true);
  const briefHash = checkedHash(input.briefHash, 'briefHash');
  const worker = checkedAddress(input.worker, 'worker');
  const transaction = new Transaction();
  const [escrowCoin] = transaction.splitCoins(transaction.gas, [amountMist]);

  transaction.moveCall({
    target: escrowCall(input.packageId, 'create_and_fund'),
    arguments: [
      escrowCoin,
      transaction.pure.address(worker),
      transaction.pure.vector('u8', briefHash),
      transaction.pure.u64(deadlineMs),
      transaction.object.clock(),
    ],
  });

  return transaction;
}

/** Build a worker submission transaction; the Move module enforces the worker address. */
export function buildSubmitTx(input: BuildSubmitTxInput): Transaction {
  const commitmentHash = checkedHash(input.commitmentHash, 'commitmentHash');
  const transaction = new Transaction();

  transaction.moveCall({
    target: escrowCall(input.packageId, 'submit'),
    arguments: [
      transaction.object(checkedJobId(input.jobId)),
      transaction.pure.vector('u8', commitmentHash),
      transaction.object.clock(),
    ],
  });

  return transaction;
}

/** Build a funder release transaction; the Move module enforces the funder address. */
export function buildReleaseTx(input: BuildJobTxInput): Transaction {
  const transaction = new Transaction();
  transaction.moveCall({
    target: escrowCall(input.packageId, 'release'),
    arguments: [transaction.object(checkedJobId(input.jobId))],
  });
  return transaction;
}

/** Build an expired, unsubmitted refund transaction; the Move module checks both conditions. */
export function buildRefundTx(input: BuildJobTxInput): Transaction {
  const transaction = new Transaction();
  transaction.moveCall({
    target: escrowCall(input.packageId, 'refund'),
    arguments: [transaction.object(checkedJobId(input.jobId)), transaction.object.clock()],
  });
  return transaction;
}

/**
 * Resolve and freeze the exact transaction the wallet will sign. This fills
 * shared-object versions, gas selection/price/budget and expiration through the
 * gRPC client, then returns the digest and both SDK-supported signing forms.
 */
export async function resolveEscrowTxForSigning(
  transaction: Transaction,
  input: ResolveEscrowTxInput,
): Promise<FrozenEscrowTransaction> {
  transaction.setSender(checkedAddress(input.sender, 'sender'));
  const client = input.client ?? createSuiTestnetClient();
  const bytes = await transaction.build({ client });
  if (!transaction.isFullyResolved()) {
    throw new Error('Sui SDK did not fully resolve the escrow transaction');
  }

  const digest = await transaction.getDigest();
  const transactionJson = await transaction.toJSON();
  const jsonDigest = (JSON.parse(transactionJson) as { digest?: unknown }).digest;
  if (jsonDigest !== digest) {
    throw new Error('Resolved transaction JSON does not match its frozen digest');
  }

  return {
    digest,
    transactionBytesBase64: toBase64(bytes),
    transactionJson,
  };
}

function bytesToHex(bytes: Iterable<number>): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Escrow event BCS did not decode to a record');
  }
  return value as Record<string, unknown>;
}

function expectedEventName(kind: EscrowReceiptKind): string {
  switch (kind) {
    case 'created': return 'JobCreated';
    case 'submitted': return 'WorkSubmitted';
    case 'released': return 'JobReleased';
    case 'refunded': return 'JobRefunded';
  }
}

/**
 * Wait for a finalized gRPC transaction and verify the exact module event using
 * BCS (rather than trusting client-supplied state or the lossy JSON event form).
 */
export async function validateEscrowReceipt(
  input: ValidateEscrowReceiptInput,
  client: SuiGrpcClient = createSuiTestnetClient(),
): Promise<ValidatedEscrowReceipt> {
  const packageId = checkedAddress(input.packageId, 'packageId');
  const expectedActor = checkedAddress(input.expectedActor, 'expectedActor');
  if (!isValidTransactionDigest(input.digest)) {
    throw new TypeError('digest must be a valid Sui transaction digest');
  }

  const result = await client.waitForTransaction({
    digest: input.digest,
    include: { transaction: true, events: true, effects: true },
  });
  if (result.$kind !== 'Transaction' || !result.Transaction.status.success) {
    throw new Error(`Escrow transaction ${input.digest} did not succeed`);
  }

  const transaction = result.Transaction;
  const sender = transaction.transaction?.sender;
  if (!sender || checkedAddress(sender, 'transaction sender') !== expectedActor) {
    throw new Error('Escrow receipt sender does not match the expected actor');
  }
  if (transaction.digest !== input.digest) {
    throw new Error('Escrow receipt digest does not match the requested digest');
  }

  const eventName = expectedEventName(input.expectedKind);
  const eventType = `${packageId}::${MODULE}::${eventName}`;
  const matchingEvents = (transaction.events ?? []).filter((event) => {
    try {
      return normalizeSuiAddress(event.packageId) === packageId
        && event.module === MODULE
        && event.eventType.split('::').at(-1) === eventName;
    } catch {
      return false;
    }
  });
  if (matchingEvents.length !== 1) {
    throw new Error(`Expected one ${eventType} event, found ${matchingEvents.length}`);
  }

  const event = matchingEvents[0];
  if (checkedAddress(event.sender, 'event sender') !== expectedActor) {
    throw new Error('Escrow event sender does not match the expected actor');
  }

  let data: Record<string, unknown>;
  switch (input.expectedKind) {
    case 'created': data = asRecord(createdEvent.parse(event.bcs)); break;
    case 'submitted': data = asRecord(submittedEvent.parse(event.bcs)); break;
    case 'released': data = asRecord(releasedEvent.parse(event.bcs)); break;
    case 'refunded': data = asRecord(refundedEvent.parse(event.bcs)); break;
  }

  const jobId = checkedAddress(String(data.job_id), 'event jobId');
  const funder = checkedAddress(String(data.funder), 'event funder');
  const worker = checkedAddress(String(data.worker), 'event worker');
  const authorizedActor = input.expectedKind === 'submitted' ? worker : funder;
  if (authorizedActor !== expectedActor) {
    throw new Error('Escrow event parties do not authorize the expected actor');
  }

  const receipt: ValidatedEscrowReceipt = {
    kind: input.expectedKind,
    digest: transaction.digest,
    sender: expectedActor,
    jobId,
    funder,
    worker,
  };

  if (input.expectedKind === 'created') {
    const briefHash = data.brief_hash;
    if (!Array.isArray(briefHash) && !(briefHash instanceof Uint8Array)) {
      throw new TypeError('Created event brief hash did not decode to bytes');
    }
    receipt.amountMist = String(data.amount_mist);
    receipt.briefHash = bytesToHex(briefHash);
    receipt.deadlineMs = String(data.deadline_ms);
  } else if (input.expectedKind === 'submitted') {
    const commitmentHash = data.commitment_hash;
    if (!Array.isArray(commitmentHash) && !(commitmentHash instanceof Uint8Array)) {
      throw new TypeError('Submitted event commitment hash did not decode to bytes');
    }
    receipt.commitmentHash = bytesToHex(commitmentHash);
  } else {
    receipt.amountMist = String(data.amount_mist);
  }

  return receipt;
}
