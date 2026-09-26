import type postgres from 'postgres';
import {
  buildT2000CreateJobTx,
  buildT2000DeliverTx,
  buildT2000RatingTx,
  buildT2000RefundTx,
  buildT2000RejectTx,
  buildT2000ReleaseTx,
  buildT2000ScoreSetupTx,
  freezeT2000Transaction,
  isT2000RegisteredAgent,
  readT2000Job,
  readT2000FeeBps,
  readT2000Score,
  t2000Config,
  validateT2000JobReceipt,
  validateT2000RatingReceipt,
  validateT2000ScoreReceipt,
  type T2000Config,
  type T2000JobExpectation,
  type T2000Receipt,
} from '../sui/t2000';
import type { Job } from '@t2000/sdk';
import { db } from './db';
import { assert, HttpError } from './errors';
import { isCurrentWorkerWorldVerified, ownerForSession, workerForSession } from './identity';
import { sha256 } from './security';
import type { Session } from './session';
import type { FrozenEscrowTransaction } from '../sui/escrow';

const FEE_QUOTE_BPS = 250;
const DEFAULT_REVIEW_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_REJECT_SPLIT_BPS = 5_000;

type Row = Record<string, any>;
type FinalState = 'PAID' | 'REFUNDED' | 'REJECTED';

function paymentConfig(): T2000Config {
  try {
    return t2000Config();
  } catch {
    throw new HttpError(503, 'payment_not_configured', 'Mainnet USDC payments are not configured.');
  }
}

function frozenJson(frozen: FrozenEscrowTransaction): postgres.JSONValue {
  return JSON.parse(frozen.transactionJson) as postgres.JSONValue;
}

function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function briefHash(brief: string): string {
  return `0x${sha256(brief)}`;
}

function epochMs(value: string | Date): number {
  const result = new Date(value).getTime();
  assert(Number.isSafeInteger(result) && result > 0, 409, 'task_terms_invalid', 'Task deadline is invalid.');
  return result;
}

function amount(value: unknown): string {
  const result = String(value);
  assert(/^[1-9][0-9]*$/.test(result), 409, 'amount_invalid', 'The task amount is invalid.');
  return result;
}

function assertMainnetUsdc(row: Row): void {
  assert(row.asset === 'USDC' && row.network === 'mainnet' && Number(row.decimals) === 6 && row.legacy_read_only !== true,
    410, 'legacy_payment_read_only', 'This historical SUI/testnet record is read-only and cannot enter a t2000 payment.');
}

function sameHash(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase().replace(/^0x/, '') === right.toLowerCase().replace(/^0x/, '');
}

function quoteFor(grossAtomic: string, feeBps = FEE_QUOTE_BPS) {
  const gross = BigInt(grossAtomic);
  const fee = (gross * BigInt(feeBps)) / 10_000n;
  return { feeAtomic: fee.toString(), netAtomic: (gross - fee).toString() };
}

export function sellerGrossForRejection(grossAtomic: string, rejectSplitBps: number): string {
  const gross = BigInt(grossAtomic);
  assert(Number.isInteger(rejectSplitBps) && rejectSplitBps >= 0 && rejectSplitBps <= 10_000, 500, 'settlement_terms_invalid', 'The rejection split is invalid.');
  // The protocol field is the BUYER share. Move floors the buyer amount and
  // gives the remainder to the seller, so dust is never silently discarded.
  const buyerShare = (gross * BigInt(rejectSplitBps)) / 10_000n;
  return (gross - buyerShare).toString();
}

function settledAmounts(grossAtomic: string, job: Job, rejectedSplitBps?: number) {
  let sellerGross = BigInt(grossAtomic);
  // t2000's split is the buyer share in basis points. A rejection pays the
  // seller the remainder, and the fee is calculated from that seller gross.
  if (rejectedSplitBps !== undefined) sellerGross = BigInt(sellerGrossForRejection(grossAtomic, rejectedSplitBps));
  const fee = (sellerGross * BigInt(job.feeBps)) / 10_000n;
  return { sellerGrossAtomic: sellerGross.toString(), feeAtomic: fee.toString(), netAtomic: (sellerGross - fee).toString(), feeBps: job.feeBps };
}

function termsFromRow(row: Row, buyer: string, seller: string, hash = row.brief_hash ?? briefHash(String(row.brief ?? ''))): T2000JobExpectation {
  return {
    buyer,
    seller,
    amountAtomic: amount(row.amount_atomic ?? row.settlement_amount_atomic),
    specHash: String(hash),
    deliverByMs: epochMs(row.deadline ?? row.reserved_deadline),
    reviewWindowMs: Number(row.review_window_ms ?? DEFAULT_REVIEW_WINDOW_MS),
    rejectSplitBps: Number(row.reject_split_bps ?? DEFAULT_REJECT_SPLIT_BPS),
  };
}

function actionResult(taskId: string, frozen: FrozenEscrowTransaction, config: T2000Config, extra: Row = {}) {
  return {
    taskId,
    transactionBytesBase64: frozen.transactionBytesBase64,
    expectedDigest: frozen.digest,
    asset: config.asset,
    network: config.network,
    decimals: config.decimals,
    ...extra,
  };
}

function settlementDto(row: Row | null | undefined) {
  if (!row) return null;
  const gross = amount(row.amount_atomic ?? row.settlement_amount_atomic);
  return {
    amountAtomic: gross,
    grossAtomic: gross,
    feeAtomic: row.fee_atomic == null ? null : String(row.fee_atomic),
    netAtomic: row.net_atomic == null ? null : String(row.net_atomic),
    feeBps: row.fee_bps == null ? null : Number(row.fee_bps),
    feeQuoteBps: row.fee_quote_bps == null ? null : Number(row.fee_quote_bps),
    feeQuoteAtomic: row.fee_quote_atomic == null ? null : String(row.fee_quote_atomic),
    fundingFeeBps: row.funding_fee_bps == null ? null : Number(row.funding_fee_bps),
    feeChanged: row.funding_fee_bps != null && row.fee_quote_bps != null && Number(row.funding_fee_bps) !== Number(row.fee_quote_bps),
    feeAcknowledgedAt: row.fee_acknowledged_at ? new Date(row.fee_acknowledged_at).toISOString() : null,
    asset: row.asset ?? 'USDC',
    network: row.network,
    decimals: Number(row.decimals ?? 6),
    coinType: row.coin_type ?? null,
    packageId: row.package_id ?? null,
    jobId: row.job_id ?? null,
    scoreReadyAt: row.score_ready_at ? new Date(row.score_ready_at).toISOString() : null,
    scoreReady: row.score_ready_at != null,
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    fundingDigest: row.funding_digest ?? null,
    submissionDigest: row.submission_digest ?? null,
    releaseDigest: row.release_digest ?? null,
    refundDigest: row.refund_digest ?? null,
    rejectionDigest: row.rejection_digest ?? null,
    reviewWindowMs: Number(row.review_window_ms ?? DEFAULT_REVIEW_WINDOW_MS),
    rejectSplitBps: Number(row.reject_split_bps ?? DEFAULT_REJECT_SPLIT_BPS),
    status: row.status ?? null,
  };
}

async function latestSettlement(taskId: string) {
  const [row] = await db()`SELECT * FROM settlements WHERE task_id = ${taskId}`;
  return row as Row | undefined;
}

function genericBuildFailure(code: string, message: string): never {
  throw new HttpError(503, code, message);
}

/** Read and persist the deterministic score object ID.  A score transaction
 * digest is a receipt only and is never a valid Move object argument. */
async function settlementSellerScore(tx: any, taskId: string, config: T2000Config, wallet: string, storedId?: string | null, storedSender?: string | null): Promise<string> {
  const score = await readT2000Score(config.client, wallet, config.scoreBoardId);
  assert(score.exists, 409, 'score_setup_required', 'Create the worker t2000 score before this action.');
  if (storedId) assert(sameAddress(storedId, score.id), 409, 'score_snapshot_changed', 'The stored worker score object changed.');
  // score_sender records who sponsored score creation.  The object itself is
  // owned by the seller wallet, so an owner-sponsored recovery is valid and
  // must remain usable by later seller/timeout actions.
  void storedSender;
  await tx`UPDATE settlements SET score_id = ${score.id}, score_sender = COALESCE(score_sender, ${wallet}), score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
  return score.id;
}

async function validateJobReceipt(input: {
  config: T2000Config;
  digest: string;
  expectedSender: string;
  expectedState: Job['state'];
  expected: T2000JobExpectation;
  jobId?: string;
  expectedDeliveryHash?: string;
}): Promise<T2000Receipt> {
  try {
    return await validateT2000JobReceipt({
      client: input.config.client,
      packageId: input.config.packageId,
      digest: input.digest,
      expectedSender: input.expectedSender,
      expectedState: input.expectedState,
      expected: input.expected,
      jobId: input.jobId,
      expectedDeliveryHash: input.expectedDeliveryHash,
    });
  } catch {
    throw new HttpError(400, 'payment_receipt_invalid', 'The finalized t2000 receipt did not match the frozen task terms.');
  }
}

function receiptExpected(row: Row, buyer: string, seller: string): T2000JobExpectation {
  return termsFromRow(row, buyer, seller, row.brief_hash);
}

export async function buildFundingTransaction(session: Session, taskId: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  return db().begin(async (tx) => {
    const [task] = await tx`
      SELECT t.id, t.owner_id, t.agent_id, t.brief, t.amount_atomic, t.asset, t.network, t.decimals,
             t.legacy_read_only, t.deadline, t.state, t.assigned_worker_id, t.review_window_ms, t.reject_split_bps,
             a.id AS approval_id, a.status AS approval_status, a.amount_atomic AS approval_amount_atomic,
             a.asset AS approval_asset, a.network AS approval_network, a.decimals AS approval_decimals,
             a.review_window_ms AS approval_review_window_ms, a.reject_split_bps AS approval_reject_split_bps,
             a.fee_quote_bps, a.fee_quote_atomic, a.net_quote_atomic, a.worker_id AS approval_worker_id,
             a.worker_wallet, a.owner_wallet, a.expires_at, a.consented_at,
             a.transaction_bytes_base64, a.expected_digest,
             w.status AS worker_status, w.wallet_address,
             w.idkit_verified_at, w.idkit_verified_environment, w.idkit_credential,
             w.idkit_credential_schema, w.idkit_action,
             o.wallet_address AS linked_owner_wallet
      FROM tasks t
      JOIN approvals a ON a.task_id = t.id AND a.kind = 'HIRE' AND a.owner_id = t.owner_id
        AND ((t.state = 'FUNDING' AND a.status = 'ISSUED')
          OR (t.state = 'ASSIGNED' AND a.status = 'APPROVED'))
      JOIN workers w ON w.id = t.assigned_worker_id
      JOIN owners o ON o.id = t.owner_id
      WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
      FOR UPDATE OF t, a, w, o
    ` as Row[];
    assert(task, 404, 'task_not_found', 'Task was not found for this owner.');
    assertMainnetUsdc(task);
    const quoted = quoteFor(amount(task.amount_atomic), Number(task.fee_quote_bps ?? FEE_QUOTE_BPS));
    if (task.state === 'FUNDING' && task.approval_status === 'ISSUED' && task.transaction_bytes_base64 && task.expected_digest) {
      return actionResult(taskId, { digest: task.expected_digest, transactionBytesBase64: task.transaction_bytes_base64, transactionJson: '' }, config, {
        state: 'FUNDING', amountAtomic: amount(task.amount_atomic), feeQuoteBps: Number(task.fee_quote_bps ?? FEE_QUOTE_BPS),
        feeQuoteAtomic: task.fee_quote_atomic == null ? quoted.feeAtomic : String(task.fee_quote_atomic),
        netQuoteAtomic: task.net_quote_atomic == null ? quoted.netAtomic : String(task.net_quote_atomic),
        terms: { reviewWindowMs: Number(task.review_window_ms), rejectSplitBps: Number(task.reject_split_bps) },
      });
    }
    assert(task.state === 'ASSIGNED' && task.approval_status === 'APPROVED', 409, 'owner_approval_required', 'Fresh owner approval for this exact task is required before funding.');
    assert(new Date(task.expires_at).getTime() > Date.now() && task.consented_at, 409, 'approval_expired', 'Owner approval has expired.');
    assert(
      isCurrentWorkerWorldVerified({
        status: task.worker_status,
        idkit_verified_at: task.idkit_verified_at,
        idkit_verified_environment: task.idkit_verified_environment,
        idkit_credential: task.idkit_credential,
        idkit_credential_schema: task.idkit_credential_schema,
        idkit_action: task.idkit_action,
      }) && task.wallet_address && sameAddress(task.wallet_address, task.worker_wallet),
      409,
      'approval_snapshot_changed',
      'The worker World verification or wallet changed; request fresh owner approval.',
    );
    assert(task.linked_owner_wallet && sameAddress(task.linked_owner_wallet, task.owner_wallet) && sameAddress(owner.wallet_address, task.owner_wallet), 409, 'approval_snapshot_changed', 'The owner wallet changed; request fresh owner approval.');
    assert(String(task.amount_atomic) === String(task.approval_amount_atomic) && task.assigned_worker_id === task.approval_worker_id, 409, 'approval_snapshot_changed', 'The task amount or worker changed; request fresh owner approval.');
    assert(task.asset === task.approval_asset && task.network === task.approval_network && Number(task.decimals) === Number(task.approval_decimals), 409, 'approval_snapshot_changed', 'The payment asset changed; request fresh owner approval.');
    assert(Number(task.review_window_ms) === Number(task.approval_review_window_ms) && Number(task.reject_split_bps) === Number(task.approval_reject_split_bps), 409, 'approval_snapshot_changed', 'The immutable t2000 terms changed; request fresh owner approval.');
    assert(new Date(task.deadline).getTime() > Date.now(), 409, 'task_expired', 'Task deadline has passed.');
    let protocolFeeBps: number;
    try {
      protocolFeeBps = await readT2000FeeBps(config.client, config.feeConfigId);
    } catch {
      genericBuildFailure('fee_quote_unavailable', 'The current t2000 protocol fee could not be read.');
    }
    assert(Number(task.fee_quote_bps ?? FEE_QUOTE_BPS) === protocolFeeBps, 409, 'fee_quote_stale', 'The t2000 protocol fee changed; request fresh owner approval before funding.');

    let frozen: FrozenEscrowTransaction;
    try {
      const built = await buildT2000CreateJobTx({
        buyer: task.owner_wallet,
        seller: task.worker_wallet,
        amountAtomic: amount(task.amount_atomic),
        specHash: briefHash(task.brief),
        deliverByMs: epochMs(task.deadline),
        reviewWindowMs: Number(task.review_window_ms),
        rejectSplitBps: Number(task.reject_split_bps),
      }, config.client);
      frozen = await freezeT2000Transaction(built, task.owner_wallet, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Funding transaction could not be prepared.');
    }
    await tx`UPDATE approvals SET status = 'ISSUED', transaction_json = ${tx.json(frozenJson(frozen))}, transaction_bytes_base64 = ${frozen.transactionBytesBase64}, expected_digest = ${frozen.digest} WHERE id = ${task.approval_id}`;
    await tx`UPDATE tasks SET state = 'FUNDING' WHERE id = ${taskId}`;
    await tx`
      INSERT INTO settlements (
        task_id, network, package_id, coin_type, amount_atomic, asset, decimals, funder_wallet, worker_wallet,
        brief_hash, deadline, review_window_ms, reject_split_bps, status,
        fee_quote_bps, fee_quote_atomic, funding_transaction_bytes_base64, funding_expected_digest
      ) VALUES (
        ${taskId}, ${config.network}, ${config.packageId}, ${config.coinType}, ${task.amount_atomic}, ${config.asset}, ${config.decimals},
        ${task.owner_wallet}, ${task.worker_wallet}, ${briefHash(task.brief)}, ${task.deadline}, ${task.review_window_ms}, ${task.reject_split_bps}, 'FUNDING',
        ${Number(task.fee_quote_bps ?? FEE_QUOTE_BPS)}, ${task.fee_quote_atomic == null ? quoted.feeAtomic : String(task.fee_quote_atomic)}, ${frozen.transactionBytesBase64}, ${frozen.digest}
      ) ON CONFLICT (task_id) DO NOTHING
    `;
    await tx`INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail) VALUES ('owner', ${owner.id}, ${taskId}, 'funding_transaction_issued', ${tx.json({ amountAtomic: amount(task.amount_atomic), asset: config.asset, network: config.network, decimals: config.decimals, reviewWindowMs: Number(task.review_window_ms), rejectSplitBps: Number(task.reject_split_bps), feeQuoteBps: Number(task.fee_quote_bps ?? FEE_QUOTE_BPS) })})`;
    return actionResult(taskId, frozen, config, {
      state: 'FUNDING', amountAtomic: amount(task.amount_atomic), feeQuoteBps: Number(task.fee_quote_bps ?? FEE_QUOTE_BPS),
      feeQuoteAtomic: task.fee_quote_atomic == null ? quoted.feeAtomic : String(task.fee_quote_atomic),
      netQuoteAtomic: task.net_quote_atomic == null ? quoted.netAtomic : String(task.net_quote_atomic),
      terms: { reviewWindowMs: Number(task.review_window_ms), rejectSplitBps: Number(task.reject_split_bps) },
    });
  });
}

export async function confirmFunding(session: Session, taskId: string, digest: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  const [snapshot] = await db()`
    SELECT t.state, t.owner_id, t.agent_id, t.amount_atomic, t.asset, t.network, t.decimals,
           t.legacy_read_only, t.brief, t.deadline, t.review_window_ms, t.reject_split_bps, t.assigned_worker_id,
           w.wallet_address AS worker_wallet, o.wallet_address AS owner_wallet,
           s.network AS settlement_network, s.package_id, s.coin_type, s.amount_atomic AS reserved_amount,
           s.asset AS settlement_asset, s.decimals AS settlement_decimals, s.funder_wallet, s.worker_wallet AS reserved_worker,
           s.brief_hash, s.deadline AS reserved_deadline, s.review_window_ms AS settlement_review_window_ms,
           s.reject_split_bps AS settlement_reject_split_bps, s.fee_quote_bps, s.fee_quote_atomic, s.funding_fee_bps,
           s.funding_digest, s.funding_expected_digest, s.job_id
    FROM tasks t JOIN workers w ON w.id = t.assigned_worker_id JOIN owners o ON o.id = t.owner_id
    JOIN settlements s ON s.task_id = t.id
    WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Funding attempt was not found for this owner.');
  assertMainnetUsdc(snapshot);
  if (snapshot.state === 'FUNDED' && snapshot.funding_digest === digest) return { taskId, state: 'FUNDED', digest, jobId: snapshot.job_id, settlement: settlementDto(await latestSettlement(taskId)) };
  assert(snapshot.state === 'FUNDING' && snapshot.settlement_network === config.network && snapshot.package_id === config.packageId, 409, 'funding_not_pending', 'Task has no active funding transaction.');
  assert(snapshot.funding_expected_digest && snapshot.funding_expected_digest === digest, 409, 'funding_digest_mismatch', 'Digest does not match the frozen funding transaction for this task.');
  assert(snapshot.owner_wallet && sameAddress(snapshot.owner_wallet, snapshot.funder_wallet) && snapshot.worker_wallet && sameAddress(snapshot.worker_wallet, snapshot.reserved_worker), 409, 'settlement_snapshot_changed', 'A linked wallet changed during funding.');
  assert(String(snapshot.amount_atomic) === String(snapshot.reserved_amount), 409, 'settlement_snapshot_changed', 'The funding amount changed.');
  const receipt = await validateJobReceipt({
    config, digest, expectedSender: snapshot.owner_wallet, expectedState: 'funded',
    expected: receiptExpected({ ...snapshot, amount_atomic: snapshot.reserved_amount, brief_hash: snapshot.brief_hash, deadline: snapshot.reserved_deadline, review_window_ms: snapshot.settlement_review_window_ms, reject_split_bps: snapshot.settlement_reject_split_bps }, snapshot.owner_wallet, snapshot.worker_wallet),
  });
  const actualFeeBps = Number(receipt.job.feeBps);
  assert(Number.isSafeInteger(actualFeeBps) && actualFeeBps >= 0 && actualFeeBps <= 1_000, 400, 'payment_receipt_invalid', 'The finalized t2000 receipt contained an invalid protocol fee.');
  const feeChanged = snapshot.fee_quote_bps != null && actualFeeBps !== Number(snapshot.fee_quote_bps);
  const result = await db().begin(async (tx) => {
    const [task] = await tx`SELECT state, funding_digest FROM tasks WHERE id = ${taskId} AND owner_id = ${owner.id} FOR UPDATE` as Row[];
    assert(task, 404, 'task_not_found', 'Task was not found for this owner.');
    if (task.state === 'FUNDED' && task.funding_digest === digest) return null;
    assert(task.state === 'FUNDING', 409, 'funding_not_pending', 'Task funding has already been reconciled.');
    await tx`UPDATE tasks SET state = 'FUNDED', job_id = ${receipt.jobId}, funding_digest = ${digest} WHERE id = ${taskId}`;
    await tx`UPDATE approvals SET status = 'CONSUMED' WHERE task_id = ${taskId} AND kind = 'HIRE' AND status = 'ISSUED'`;
    await tx`UPDATE settlements SET status = 'FUNDED', job_id = ${receipt.jobId}, funding_digest = ${digest}, funding_fee_bps = ${actualFeeBps} WHERE task_id = ${taskId}`;
    await tx`INSERT INTO audit_events (actor_type, actor_id, task_id, event_type) VALUES ('chain', NULL, ${taskId}, 'funding_confirmed')`;
    const [settlement] = await tx`SELECT * FROM settlements WHERE task_id = ${taskId}` as Row[];
    return settlement;
  });
  const settlement = result ?? await latestSettlement(taskId);
  return { taskId, state: 'FUNDED', digest, jobId: receipt.jobId, feeQuoteBps: snapshot.fee_quote_bps == null ? null : Number(snapshot.fee_quote_bps), fundingFeeBps: actualFeeBps, feeChanged, workerAcknowledgementRequired: feeChanged, settlement: settlementDto(settlement) };
}

/** Record the worker's explicit consent when the protocol fee at funding was
 * different from the quote frozen into owner approval.  This acknowledgement
 * is deliberately separate from submission so a worker can inspect the exact
 * finalized fee before doing any work. */
export async function acknowledgeFundingFee(session: Session, taskId: string) {
  const worker = await workerForSession(session);
  const [snapshot] = await db()`
    SELECT t.state, t.asset, t.network, t.decimals, t.legacy_read_only, t.assigned_worker_id,
           s.status AS settlement_status, s.fee_quote_bps, s.funding_fee_bps, s.fee_acknowledged_at
    FROM tasks t JOIN settlements s ON s.task_id = t.id
    WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'A funded task was not found for this worker.');
  assertMainnetUsdc(snapshot);
  assert(snapshot.state === 'FUNDED' && snapshot.settlement_status === 'FUNDED', 409, 'fee_acknowledgement_not_ready', 'Fee acknowledgement is only available before worker submission.');
  assert(snapshot.fee_quote_bps != null && snapshot.funding_fee_bps != null && Number(snapshot.fee_quote_bps) !== Number(snapshot.funding_fee_bps), 409, 'fee_acknowledgement_not_required', 'The finalized protocol fee matches the owner quote.');
  if (snapshot.fee_acknowledged_at) {
    return { taskId, state: 'FUNDED', feeQuoteBps: Number(snapshot.fee_quote_bps), fundingFeeBps: Number(snapshot.funding_fee_bps), feeAcknowledgedAt: new Date(snapshot.fee_acknowledged_at).toISOString(), settlement: settlementDto(await latestSettlement(taskId)) };
  }
  const result = await db().begin(async (tx) => {
    const [locked] = await tx`
      SELECT t.state, s.status AS settlement_status, s.fee_quote_bps, s.funding_fee_bps, s.fee_acknowledged_at
      FROM tasks t JOIN settlements s ON s.task_id = t.id
      WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
      FOR UPDATE OF t, s
    ` as Row[];
    assert(locked, 404, 'task_not_found', 'A funded task was not found for this worker.');
    assert(locked.state === 'FUNDED' && locked.settlement_status === 'FUNDED', 409, 'fee_acknowledgement_not_ready', 'Fee acknowledgement is only available before worker submission.');
    assert(locked.fee_quote_bps != null && locked.funding_fee_bps != null && Number(locked.fee_quote_bps) !== Number(locked.funding_fee_bps), 409, 'fee_acknowledgement_not_required', 'The finalized protocol fee matches the owner quote.');
    await tx`UPDATE settlements SET fee_acknowledged_at = COALESCE(fee_acknowledged_at, now()) WHERE task_id = ${taskId}`;
    await tx`INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail) VALUES ('worker', ${worker.id}, ${taskId}, 'funding_fee_acknowledged', ${tx.json({ feeQuoteBps: Number(locked.fee_quote_bps), fundingFeeBps: Number(locked.funding_fee_bps) })})`;
    const [settlement] = await tx`SELECT * FROM settlements WHERE task_id = ${taskId}` as Row[];
    return settlement;
  });
  return { taskId, state: 'FUNDED', feeQuoteBps: Number(result.fee_quote_bps), fundingFeeBps: Number(result.funding_fee_bps), feeAcknowledgedAt: result.fee_acknowledged_at ? new Date(result.fee_acknowledged_at).toISOString() : null, settlement: settlementDto(result) };
}

export async function buildScoreSetupTransaction(session: Session, taskId: string) {
  const worker = await workerForSession(session);
  const config = paymentConfig();
  return db().begin(async (tx) => {
    const [snapshot] = await tx`
      SELECT t.state, t.assigned_worker_id, t.asset, t.network, t.decimals, t.legacy_read_only,
             s.score_transaction_bytes_base64, s.score_expected_digest, s.score_digest, s.score_id, s.score_sender, s.score_ready_at,
             s.refund_score_transaction_bytes_base64, s.refund_score_expected_digest, s.refund_score_digest, s.refund_score_sender
      FROM tasks t JOIN settlements s ON s.task_id = t.id
      WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
      FOR UPDATE OF t, s
    ` as Row[];
    assert(snapshot, 404, 'task_not_found', 'A funded task was not found for this worker.');
    assertMainnetUsdc(snapshot);
    assert(['FUNDED', 'SUBMITTED', 'REVIEW'].includes(snapshot.state), 409, 'score_setup_not_ready', 'The task is not ready for a worker score.');
    if (snapshot.score_digest) {
      const score = await readT2000Score(config.client, worker.wallet_address, config.scoreBoardId);
      assert(score.exists, 409, 'score_unavailable', 'The confirmed worker score is no longer available.');
      assert(!snapshot.score_id || sameAddress(snapshot.score_id, score.id), 409, 'score_snapshot_changed', 'The stored worker score object changed.');
      await tx`UPDATE settlements SET score_id = ${score.id}, score_sender = COALESCE(score_sender, ${worker.wallet_address}), score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
      return { taskId, state: 'SCORE_READY', digest: snapshot.score_digest, scoreId: score.id, scoreReadyAt: snapshot.score_ready_at ? new Date(snapshot.score_ready_at).toISOString() : new Date().toISOString(), alreadyExists: true, asset: config.asset, network: config.network, decimals: config.decimals };
    }
    let score;
    try {
      score = await readT2000Score(config.client, worker.wallet_address, config.scoreBoardId);
    } catch {
      genericBuildFailure('score_unavailable', 'The worker t2000 score could not be read.');
    }
    if (score.exists) {
      await tx`UPDATE settlements SET score_id = ${score.id}, score_sender = COALESCE(score_sender, ${worker.wallet_address}), score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
      return { taskId, state: 'SCORE_READY', scoreId: score.id, scoreReadyAt: snapshot.score_ready_at ? new Date(snapshot.score_ready_at).toISOString() : new Date().toISOString(), alreadyExists: true, asset: config.asset, network: config.network, decimals: config.decimals };
    }
    if (snapshot.score_transaction_bytes_base64 && snapshot.score_expected_digest) {
      assert(!snapshot.score_sender || sameAddress(snapshot.score_sender, worker.wallet_address), 409, 'score_setup_actor_mismatch', 'The frozen score setup transaction belongs to another signer.');
      return { taskId, state: 'SCORE_FUNDING', transactionBytesBase64: snapshot.score_transaction_bytes_base64, expectedDigest: snapshot.score_expected_digest, scoreId: snapshot.score_id ?? score.id, scoreReadyAt: null, asset: config.asset, network: config.network, decimals: config.decimals };
    }
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000ScoreSetupTx(worker.wallet_address, config.scoreBoardId), worker.wallet_address, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Score setup transaction could not be prepared.');
    }
    await tx`UPDATE settlements SET score_transaction_json = ${tx.json(frozenJson(frozen))}, score_transaction_bytes_base64 = ${frozen.transactionBytesBase64}, score_expected_digest = ${frozen.digest}, score_sender = ${worker.wallet_address} WHERE task_id = ${taskId}`;
    return actionResult(taskId, frozen, config, { state: 'SCORE_FUNDING', scoreId: score.id, scoreReadyAt: null });
  });
}

export async function confirmScoreSetup(session: Session, taskId: string, digest: string) {
  const worker = await workerForSession(session);
  const config = paymentConfig();
  const [snapshot] = await db()`
    SELECT t.assigned_worker_id, t.asset, t.network, t.decimals, t.legacy_read_only, s.score_expected_digest, s.score_digest, s.score_id, s.score_sender, s.score_ready_at
    FROM tasks t JOIN settlements s ON s.task_id = t.id WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Task was not found for this worker.');
  assertMainnetUsdc(snapshot);
  if (snapshot.score_digest === digest) {
    let score;
    try {
      score = await readT2000Score(config.client, worker.wallet_address, config.scoreBoardId);
    } catch {
      throw new HttpError(409, 'score_unavailable', 'The confirmed worker score could not be read.');
    }
    assert(score.exists, 409, 'score_unavailable', 'The confirmed worker score is no longer available.');
    assert(!snapshot.score_id || sameAddress(snapshot.score_id, score.id), 409, 'score_snapshot_changed', 'The stored worker score object changed.');
    const readyAt = snapshot.score_ready_at ? new Date(snapshot.score_ready_at).toISOString() : new Date().toISOString();
    await db()`UPDATE settlements SET score_id = ${score.id}, score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
    return { taskId, state: 'SCORE_READY', digest, scoreId: score.id, scoreReadyAt: readyAt, asset: config.asset, network: config.network, decimals: config.decimals };
  }
  assert(snapshot.score_expected_digest === digest, 409, 'score_digest_mismatch', 'Digest does not match the frozen score setup transaction.');
  assert(!snapshot.score_sender || sameAddress(snapshot.score_sender, worker.wallet_address), 409, 'score_setup_actor_mismatch', 'The frozen score setup transaction belongs to another signer.');
  let receipt;
  try {
    receipt = await validateT2000ScoreReceipt({ client: config.client, digest, expectedSender: worker.wallet_address, agent: worker.wallet_address, boardId: config.scoreBoardId });
  } catch {
    // An owner-sponsored refund prerequisite may have won the deterministic
    // score race while this worker transaction was still frozen.  Reconcile
    // the object before asking the worker to retry; never issue another score
    // or payment transaction for that race.
    let score;
    try {
      score = await readT2000Score(config.client, worker.wallet_address, config.scoreBoardId);
    } catch {
      throw new HttpError(400, 'score_receipt_invalid', 'The finalized score transaction did not create the expected score.');
    }
    if (!score.exists) throw new HttpError(400, 'score_receipt_invalid', 'The finalized score transaction did not create the expected score.');
    await db()`UPDATE settlements SET score_id = ${score.id}, score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId} AND score_expected_digest = ${digest}`;
    return { taskId, state: 'SCORE_READY', digest, scoreId: score.id, scoreReadyAt: new Date().toISOString(), raceReconciled: true, asset: config.asset, network: config.network, decimals: config.decimals };
  }
  await db()`UPDATE settlements SET score_digest = ${digest}, score_id = ${receipt.scoreId}, score_sender = ${worker.wallet_address}, score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId} AND score_expected_digest = ${digest}`;
  return { taskId, state: 'SCORE_READY', digest, scoreId: receipt.scoreId, scoreReadyAt: new Date().toISOString(), asset: config.asset, network: config.network, decimals: config.decimals };
}

export async function buildSubmissionTransaction(session: Session, taskId: string) {
  const worker = await workerForSession(session);
  const config = paymentConfig();
  return db().begin(async (tx) => {
    const [task] = await tx`
      SELECT t.id, t.state, t.assigned_worker_id, t.job_id, t.asset, t.network, t.decimals, t.legacy_read_only,
             e.commitment_hash, s.package_id, s.amount_atomic, s.status AS settlement_status,
             s.submit_transaction_bytes_base64, s.submit_expected_digest, s.score_id, s.score_sender,
             s.fee_quote_bps, s.funding_fee_bps, s.fee_acknowledged_at
      FROM tasks t JOIN evidence e ON e.task_id = t.id JOIN settlements s ON s.task_id = t.id
      WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
      FOR UPDATE OF t, s
    ` as Row[];
    assert(task, 404, 'task_not_found', 'Funded task with evidence was not found for this worker.');
    assertMainnetUsdc(task);
    if (task.submit_transaction_bytes_base64 && task.submit_expected_digest) return actionResult(taskId, { digest: task.submit_expected_digest, transactionBytesBase64: task.submit_transaction_bytes_base64, transactionJson: '' }, config, { state: task.state, commitmentHash: task.commitment_hash });
    assert(task.state === 'FUNDED' && task.settlement_status === 'FUNDED' && task.package_id === config.packageId && task.job_id, 409, 'task_not_funded', 'Task is not ready for worker submission.');
    assert(!(task.fee_quote_bps != null && task.funding_fee_bps != null
      && Number(task.fee_quote_bps) !== Number(task.funding_fee_bps)
      && !task.fee_acknowledged_at), 409, 'fee_changed_acknowledgement_required', 'The finalized protocol fee changed from the owner quote; acknowledge it before submitting work.');
    const scoreId = await settlementSellerScore(tx, taskId, config, worker.wallet_address, task.score_id, task.score_sender);
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000DeliverTx(task.job_id, task.commitment_hash, scoreId), worker.wallet_address, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Submission transaction could not be prepared.');
    }
    await tx`UPDATE settlements SET submit_transaction_json = ${tx.json(frozenJson(frozen))}, submit_transaction_bytes_base64 = ${frozen.transactionBytesBase64}, submit_expected_digest = ${frozen.digest} WHERE task_id = ${taskId}`;
    return actionResult(taskId, frozen, config, { state: 'FUNDED', commitmentHash: task.commitment_hash });
  });
}

export async function confirmSubmission(session: Session, taskId: string, digest: string) {
  const worker = await workerForSession(session);
  const config = paymentConfig();
  const [snapshot] = await db()`
    SELECT t.state, t.job_id, t.assigned_worker_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only,
           t.review_window_ms, t.reject_split_bps, e.commitment_hash,
           s.package_id, s.status AS settlement_status, s.worker_wallet, s.funder_wallet, s.brief_hash,
           s.deadline AS settlement_deadline, s.review_window_ms AS settlement_review_window_ms,
           s.reject_split_bps AS settlement_reject_split_bps, s.submission_digest, s.submit_expected_digest,
           s.funding_fee_bps, s.fee_quote_bps, s.fee_acknowledged_at
    FROM tasks t JOIN evidence e ON e.task_id = t.id JOIN settlements s ON s.task_id = t.id
    WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Task was not found for this worker.');
  assertMainnetUsdc(snapshot);
  if (snapshot.state === 'SUBMITTED' && snapshot.submission_digest === digest) return { taskId, state: 'SUBMITTED', digest, settlement: settlementDto(await latestSettlement(taskId)) };
  assert(snapshot.state === 'FUNDED' && snapshot.settlement_status === 'FUNDED' && snapshot.package_id === config.packageId && snapshot.job_id, 409, 'submission_not_pending', 'Task is not ready for submission reconciliation.');
  assert(snapshot.submit_expected_digest === digest, 409, 'submission_digest_mismatch', 'Digest does not match the frozen submission transaction for this task.');
  const receipt = await validateJobReceipt({
    config, digest, expectedSender: snapshot.worker_wallet, expectedState: 'delivered', jobId: snapshot.job_id,
    expected: receiptExpected({ ...snapshot, amount_atomic: snapshot.amount_atomic, brief_hash: snapshot.brief_hash, deadline: snapshot.settlement_deadline, review_window_ms: snapshot.settlement_review_window_ms, reject_split_bps: snapshot.settlement_reject_split_bps }, snapshot.funder_wallet, snapshot.worker_wallet),
    expectedDeliveryHash: snapshot.commitment_hash,
  });
  const deliveredAtMs = receipt.job.deliveredAtMs;
  assert(deliveredAtMs !== null && Number.isSafeInteger(deliveredAtMs) && deliveredAtMs > 0, 400, 'payment_receipt_invalid', 'The finalized t2000 receipt did not include a valid chain delivery timestamp.');
  const deliveredAt = new Date(deliveredAtMs);
  assert(Number.isFinite(deliveredAt.getTime()), 400, 'payment_receipt_invalid', 'The finalized t2000 delivery timestamp is invalid.');
  const result = await db().begin(async (tx) => {
    const [task] = await tx`SELECT state, submission_digest FROM tasks WHERE id = ${taskId} AND assigned_worker_id = ${worker.id} FOR UPDATE` as Row[];
    assert(task, 404, 'task_not_found', 'Task was not found for this worker.');
    if (task.state === 'SUBMITTED' && task.submission_digest === digest) return null;
    assert(task.state === 'FUNDED', 409, 'submission_not_pending', 'Task submission has already been reconciled.');
    await tx`UPDATE tasks SET state = 'SUBMITTED', submission_digest = ${digest}, commitment_hash = ${snapshot.commitment_hash}, delivered_at = ${deliveredAt.toISOString()} WHERE id = ${taskId}`;
    await tx`UPDATE settlements SET status = 'SUBMITTED', submission_digest = ${digest}, delivered_at = ${deliveredAt.toISOString()} WHERE task_id = ${taskId}`;
    await tx`INSERT INTO audit_events (actor_type, actor_id, task_id, event_type) VALUES ('chain', NULL, ${taskId}, 'submission_confirmed')`;
    const [settlement] = await tx`SELECT * FROM settlements WHERE task_id = ${taskId}` as Row[];
    return settlement;
  });
  return { taskId, state: 'SUBMITTED', digest, jobId: receipt.jobId, settlement: settlementDto(result ?? await latestSettlement(taskId)) };
}

export async function buildReleaseTransaction(session: Session, taskId: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  return db().begin(async (tx) => {
    const [snapshot] = await tx`
      SELECT t.state, t.review_decision, t.job_id, t.assigned_worker_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only,
             t.review_window_ms, t.reject_split_bps, t.deadline, t.brief,
             a.id AS approval_id, a.status AS approval_status, a.amount_atomic AS approved_amount_atomic,
             a.asset AS approved_asset, a.network AS approved_network, a.decimals AS approved_decimals,
             a.review_window_ms AS approved_review_window_ms, a.reject_split_bps AS approved_reject_split_bps,
             a.transaction_bytes_base64, a.expected_digest, a.expires_at, a.consented_at,
             a.worker_id AS approved_worker, a.worker_wallet AS approved_worker_wallet, a.owner_wallet AS approved_owner_wallet,
             o.wallet_address AS current_owner_wallet, w.wallet_address AS current_worker_wallet,
             s.package_id, s.status AS settlement_status, s.worker_wallet, s.funder_wallet, s.brief_hash,
             s.release_expected_digest, s.release_transaction_bytes_base64, s.release_sender, s.score_id, s.score_sender
      FROM tasks t JOIN approvals a ON a.task_id = t.id AND a.kind = 'RELEASE'
      JOIN owners o ON o.id = t.owner_id JOIN workers w ON w.id = t.assigned_worker_id
      JOIN settlements s ON s.task_id = t.id
      WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1
      FOR UPDATE OF t, a, o, w, s
    ` as Row[];
    assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
    assertMainnetUsdc(snapshot);
    if (snapshot.approval_status === 'ISSUED' && snapshot.transaction_bytes_base64 && snapshot.expected_digest) return actionResult(taskId, { digest: snapshot.expected_digest, transactionBytesBase64: snapshot.transaction_bytes_base64, transactionJson: '' }, config, { state: snapshot.state, amountAtomic: amount(snapshot.amount_atomic), terms: { reviewWindowMs: Number(snapshot.review_window_ms), rejectSplitBps: Number(snapshot.reject_split_bps) } });
    assert(snapshot.state === 'SUBMITTED' && snapshot.review_decision === 'ACCEPT' && snapshot.settlement_status === 'SUBMITTED' && snapshot.package_id === config.packageId, 409, 'release_not_ready', 'An accepted submission and fresh owner authorization are required.');
    assert(snapshot.approval_status === 'APPROVED' && snapshot.consented_at && new Date(snapshot.expires_at).getTime() > Date.now(), 409, 'owner_approval_required', 'Fresh owner approval for this release is required.');
    assert(!snapshot.release_expected_digest, 409, 'release_attempt_in_progress', 'A timeout release transaction is already frozen for this task.');
    assert(String(snapshot.amount_atomic) === String(snapshot.approved_amount_atomic) && snapshot.approved_worker === snapshot.assigned_worker_id, 409, 'approval_snapshot_changed', 'Task amount or worker changed after owner approval.');
    assert(snapshot.asset === snapshot.approved_asset && snapshot.network === snapshot.approved_network && Number(snapshot.decimals) === Number(snapshot.approved_decimals), 409, 'approval_snapshot_changed', 'Payment asset changed after owner approval.');
    assert(Number(snapshot.review_window_ms) === Number(snapshot.approved_review_window_ms) && Number(snapshot.reject_split_bps) === Number(snapshot.approved_reject_split_bps), 409, 'approval_snapshot_changed', 'Immutable t2000 terms changed after owner approval.');
    assert(sameAddress(snapshot.current_owner_wallet, snapshot.approved_owner_wallet) && sameAddress(snapshot.current_owner_wallet, snapshot.funder_wallet), 409, 'approval_snapshot_changed', 'Owner wallet changed after approval.');
    assert(sameAddress(snapshot.current_worker_wallet, snapshot.approved_worker_wallet) && sameAddress(snapshot.current_worker_wallet, snapshot.worker_wallet), 409, 'approval_snapshot_changed', 'Worker wallet changed after approval.');
    assert(snapshot.job_id, 409, 'job_missing', 'Confirmed t2000 job ID is missing.');
    const scoreId = await settlementSellerScore(tx, taskId, config, snapshot.current_worker_wallet, snapshot.score_id, snapshot.score_sender);
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000ReleaseTx(snapshot.job_id, scoreId), snapshot.current_owner_wallet, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Release transaction could not be prepared.');
    }
    await tx`UPDATE approvals SET status = 'ISSUED', transaction_json = ${tx.json(frozenJson(frozen))}, transaction_bytes_base64 = ${frozen.transactionBytesBase64}, expected_digest = ${frozen.digest} WHERE id = ${snapshot.approval_id}`;
    await tx`UPDATE settlements SET release_transaction_json = ${tx.json(frozenJson(frozen))}, release_transaction_bytes_base64 = ${frozen.transactionBytesBase64}, release_expected_digest = ${frozen.digest}, release_sender = ${snapshot.current_owner_wallet} WHERE task_id = ${taskId}`;
    return actionResult(taskId, frozen, config, { state: snapshot.state, amountAtomic: amount(snapshot.amount_atomic), terms: { reviewWindowMs: Number(snapshot.review_window_ms), rejectSplitBps: Number(snapshot.reject_split_bps) } });
  });
}

async function confirmReleaseWithSender(session: Session, taskId: string, digest: string, mode: 'owner' | 'timeout') {
  const config = paymentConfig();
  const actor = mode === 'owner' ? await ownerForSession(session) : await workerForSession(session);
  const [snapshot] = await db()`
    SELECT t.state, t.owner_id, t.agent_id, t.amount_atomic, t.brief, t.deadline, t.review_window_ms, t.reject_split_bps,
           t.asset, t.network, t.decimals, t.legacy_read_only, t.job_id, t.assigned_worker_id,
           w.wallet_address AS worker_wallet, o.wallet_address AS owner_wallet,
           s.package_id, s.status AS settlement_status, s.asset AS settlement_asset, s.decimals AS settlement_decimals,
           s.network AS settlement_network, s.funder_wallet, s.worker_wallet AS reserved_worker, s.brief_hash,
           s.deadline AS settlement_deadline, s.review_window_ms AS settlement_review_window_ms,
           s.reject_split_bps AS settlement_reject_split_bps, s.release_digest, s.release_expected_digest, s.release_sender
    FROM tasks t JOIN workers w ON w.id = t.assigned_worker_id JOIN owners o ON o.id = t.owner_id JOIN settlements s ON s.task_id = t.id
    WHERE t.id = ${taskId}
      AND ((${mode === 'owner'} AND t.owner_id = ${actor.id}) OR (${mode === 'timeout'} AND t.assigned_worker_id = ${actor.id}))
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Task was not found for this payment actor.');
  assertMainnetUsdc(snapshot);
  if (snapshot.state === 'PAID' && snapshot.release_digest === digest) return { taskId, state: 'PAID', digest, settlement: settlementDto(await latestSettlement(taskId)) };
  assert(snapshot.state === 'SUBMITTED' || snapshot.state === 'REVIEW', 409, 'release_not_pending', 'Task has no active release attempt.');
  assert(snapshot.settlement_status === 'SUBMITTED' && snapshot.package_id === config.packageId && snapshot.job_id, 409, 'release_not_pending', 'Task has no active release attempt.');
  assert(snapshot.release_expected_digest === digest && snapshot.release_sender, 409, 'release_digest_mismatch', 'Digest does not match the frozen release transaction for this task.');
  assert(mode === 'owner' ? sameAddress(snapshot.release_sender, snapshot.owner_wallet) : sameAddress(snapshot.release_sender, snapshot.worker_wallet), 409, 'release_actor_mismatch', 'The frozen release transaction sender does not match this action.');
  const receipt = await validateJobReceipt({
    config, digest, expectedSender: snapshot.release_sender, expectedState: 'released', jobId: snapshot.job_id,
    expected: receiptExpected({ ...snapshot, amount_atomic: snapshot.amount_atomic, brief_hash: snapshot.brief_hash, deadline: snapshot.settlement_deadline, review_window_ms: snapshot.settlement_review_window_ms, reject_split_bps: snapshot.settlement_reject_split_bps }, snapshot.funder_wallet, snapshot.worker_wallet),
  });
  const result = await settleTerminal({ taskId, digest, finalState: 'PAID', job: receipt.job, ownerId: mode === 'owner' ? actor.id : undefined });
  return { taskId, state: 'PAID', digest, jobId: receipt.jobId, settlement: settlementDto(result) };
}

export async function confirmRelease(session: Session, taskId: string, digest: string) {
  return confirmReleaseWithSender(session, taskId, digest, 'owner');
}

export async function buildRefundTransaction(session: Session, taskId: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  return db().begin(async (tx) => {
    const [snapshot] = await tx`
      SELECT t.state, t.deadline, t.job_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only,
             t.review_window_ms, t.reject_split_bps, s.package_id, s.status AS settlement_status, s.worker_wallet,
             s.refund_transaction_bytes_base64, s.refund_expected_digest, s.funder_wallet, s.refund_digest, s.release_expected_digest,
             s.score_transaction_bytes_base64, s.score_expected_digest, s.score_digest, s.score_id, s.score_sender, s.score_ready_at,
             s.refund_score_transaction_bytes_base64, s.refund_score_expected_digest, s.refund_score_sender
      FROM tasks t JOIN settlements s ON s.task_id = t.id WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
      FOR UPDATE OF t, s
    ` as Row[];
    assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
    assertMainnetUsdc(snapshot);
    if (snapshot.refund_transaction_bytes_base64 && snapshot.refund_expected_digest) return actionResult(taskId, { digest: snapshot.refund_expected_digest, transactionBytesBase64: snapshot.refund_transaction_bytes_base64, transactionJson: '' }, config, { state: snapshot.state });
    assert(snapshot.state === 'FUNDED' && snapshot.settlement_status === 'FUNDED' && snapshot.package_id === config.packageId, 409, 'refund_not_ready', 'Only a funded task with no submission can be refunded.');
    assert(!snapshot.release_expected_digest, 409, 'refund_not_ready', 'A release transaction is already frozen for this task.');
    assert(new Date(snapshot.deadline).getTime() <= Date.now(), 409, 'refund_deadline_not_reached', 'The t2000 task deadline has not passed.');
    assert(snapshot.job_id && sameAddress(owner.wallet_address, snapshot.funder_wallet), 409, 'owner_wallet_required', 'A matching signed owner wallet is required to refund.');
    const score = await readT2000Score(config.client, snapshot.worker_wallet, config.scoreBoardId);
    if (!score.exists) {
      // create_empty_score is permissionless: the owner can sponsor this
      // prerequisite when a fresh worker has no score.  Keep the frozen score
      // setup separate from refund so a retry can never issue two refunds.
      if (snapshot.refund_score_transaction_bytes_base64 && snapshot.refund_score_expected_digest) {
        assert(!snapshot.refund_score_sender || sameAddress(snapshot.refund_score_sender, owner.wallet_address), 409, 'score_setup_actor_mismatch', 'The frozen owner score setup transaction belongs to another signer.');
        return actionResult(taskId, { digest: snapshot.refund_score_expected_digest, transactionBytesBase64: snapshot.refund_score_transaction_bytes_base64, transactionJson: '' }, config, {
          state: 'SCORE_FUNDING', scoreId: score.id, scoreReadyAt: null, scoreFor: snapshot.worker_wallet, consentRequired: false,
        });
      }
      let scoreFrozen: FrozenEscrowTransaction;
      try {
        scoreFrozen = await freezeT2000Transaction(buildT2000ScoreSetupTx(snapshot.worker_wallet, config.scoreBoardId), owner.wallet_address, config.client);
      } catch {
        genericBuildFailure('transaction_build_failed', 'Owner-sponsored worker score setup could not be prepared.');
      }
      await tx`UPDATE settlements SET refund_score_transaction_json = ${tx.json(frozenJson(scoreFrozen))}, refund_score_transaction_bytes_base64 = ${scoreFrozen.transactionBytesBase64}, refund_score_expected_digest = ${scoreFrozen.digest}, refund_score_sender = ${owner.wallet_address} WHERE task_id = ${taskId}`;
      return actionResult(taskId, scoreFrozen, config, { state: 'SCORE_FUNDING', scoreId: score.id, scoreReadyAt: null, scoreFor: snapshot.worker_wallet, consentRequired: false });
    }
    assert(!snapshot.score_id || sameAddress(snapshot.score_id, score.id), 409, 'score_snapshot_changed', 'The stored worker score object changed.');
    const scoreId = score.id;
    await tx`UPDATE settlements SET score_id = ${scoreId}, score_sender = COALESCE(score_sender, ${snapshot.worker_wallet}), score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000RefundTx(snapshot.job_id, scoreId), owner.wallet_address, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Refund transaction could not be prepared.');
    }
    await tx`UPDATE settlements SET refund_transaction_json = ${tx.json(frozenJson(frozen))}, refund_transaction_bytes_base64 = ${frozen.transactionBytesBase64}, refund_expected_digest = ${frozen.digest} WHERE task_id = ${taskId}`;
    return actionResult(taskId, frozen, config, { state: snapshot.state, amountAtomic: amount(snapshot.amount_atomic), scoreId, scoreReadyAt: new Date().toISOString() });
  });
}

export async function confirmRefund(session: Session, taskId: string, digest: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  const [snapshot] = await db()`
    SELECT t.state, t.agent_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only, t.job_id, t.deadline,
           t.review_window_ms, t.reject_split_bps, s.package_id, s.status AS settlement_status, s.funder_wallet, s.worker_wallet,
           s.brief_hash, s.deadline AS settlement_deadline, s.review_window_ms AS settlement_review_window_ms,
           s.reject_split_bps AS settlement_reject_split_bps, s.refund_digest, s.refund_expected_digest,
           s.score_expected_digest, s.score_digest, s.score_id, s.score_sender, s.score_ready_at,
           s.refund_score_expected_digest, s.refund_score_digest, s.refund_score_sender
    FROM tasks t JOIN settlements s ON s.task_id = t.id WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
  assertMainnetUsdc(snapshot);
  if (snapshot.state === 'REFUNDED' && snapshot.refund_digest === digest) return { taskId, state: 'REFUNDED', digest, settlement: settlementDto(await latestSettlement(taskId)) };
  assert(snapshot.state === 'FUNDED' && snapshot.settlement_status === 'FUNDED' && snapshot.package_id === config.packageId && snapshot.job_id, 409, 'refund_not_pending', 'Task has no active refund attempt.');
  if (snapshot.score_digest === digest) {
    const readyAt = snapshot.score_ready_at ? new Date(snapshot.score_ready_at).toISOString() : new Date().toISOString();
    if (!snapshot.score_ready_at) await db()`UPDATE settlements SET score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
    return { taskId, state: 'SCORE_READY', digest, scoreId: snapshot.score_id ?? undefined, scoreReadyAt: readyAt, scoreFor: snapshot.worker_wallet, asset: config.asset, network: config.network, decimals: config.decimals };
  }
  if (snapshot.refund_score_digest === digest) {
    const readyAt = snapshot.score_ready_at ? new Date(snapshot.score_ready_at).toISOString() : new Date().toISOString();
    if (!snapshot.score_ready_at) await db()`UPDATE settlements SET score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId}`;
    return { taskId, state: 'SCORE_READY', digest, scoreId: snapshot.score_id ?? undefined, scoreReadyAt: readyAt, scoreFor: snapshot.worker_wallet, asset: config.asset, network: config.network, decimals: config.decimals };
  }
  if (snapshot.refund_score_expected_digest === digest && !snapshot.refund_score_digest) {
    assert(sameAddress(snapshot.refund_score_sender, owner.wallet_address), 409, 'score_setup_actor_mismatch', 'The frozen owner score setup transaction belongs to another signer.');
    let scoreReceipt;
    try {
      scoreReceipt = await validateT2000ScoreReceipt({ client: config.client, digest, expectedSender: owner.wallet_address, agent: snapshot.worker_wallet, boardId: config.scoreBoardId });
    } catch {
      // A worker score transaction may have been frozen first and finalized
      // concurrently.  If the deterministic score object now exists, use it
      // and let the owner continue to the single refund attempt without
      // treating the owner's raced transaction as a new prerequisite.
      let score;
      try {
        score = await readT2000Score(config.client, snapshot.worker_wallet, config.scoreBoardId);
      } catch {
        throw new HttpError(400, 'score_receipt_invalid', 'The finalized score setup transaction did not create the expected worker score.');
      }
      if (!score.exists) throw new HttpError(400, 'score_receipt_invalid', 'The finalized score setup transaction did not create the expected worker score.');
      await db()`UPDATE settlements SET score_id = ${score.id}, score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId} AND refund_score_expected_digest = ${digest} AND refund_score_digest IS NULL`;
      return { taskId, state: 'SCORE_READY', digest, scoreId: score.id, scoreReadyAt: new Date().toISOString(), scoreFor: snapshot.worker_wallet, raceReconciled: true, asset: config.asset, network: config.network, decimals: config.decimals };
    }
    await db()`UPDATE settlements SET refund_score_digest = ${digest}, score_id = ${scoreReceipt.scoreId}, score_sender = ${owner.wallet_address}, score_ready_at = COALESCE(score_ready_at, now()) WHERE task_id = ${taskId} AND refund_score_expected_digest = ${digest} AND refund_score_digest IS NULL`;
    return { taskId, state: 'SCORE_READY', digest, scoreId: scoreReceipt.scoreId, scoreReadyAt: new Date().toISOString(), scoreFor: snapshot.worker_wallet, asset: config.asset, network: config.network, decimals: config.decimals };
  }
  assert(snapshot.refund_expected_digest === digest, 409, 'refund_digest_mismatch', 'Digest does not match the frozen refund transaction for this task.');
  assert(new Date(snapshot.deadline).getTime() <= Date.now(), 409, 'refund_deadline_not_reached', 'The task deadline has not passed.');
  const receipt = await validateJobReceipt({
    config, digest, expectedSender: snapshot.funder_wallet, expectedState: 'refunded', jobId: snapshot.job_id,
    expected: receiptExpected({ ...snapshot, amount_atomic: snapshot.amount_atomic, brief_hash: snapshot.brief_hash, deadline: snapshot.settlement_deadline, review_window_ms: snapshot.settlement_review_window_ms, reject_split_bps: snapshot.settlement_reject_split_bps }, snapshot.funder_wallet, snapshot.worker_wallet),
  });
  const settlement = await settleTerminal({ taskId, digest, finalState: 'REFUNDED', job: receipt.job, ownerId: owner.id });
  return { taskId, state: 'REFUNDED', digest, jobId: receipt.jobId, settlement: settlementDto(settlement) };
}

export async function buildTimeoutClaimTransaction(session: Session, taskId: string) {
  const worker = await workerForSession(session);
  const config = paymentConfig();
  return db().begin(async (tx) => {
    const [snapshot] = await tx`
      SELECT t.state, t.job_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only,
             t.review_window_ms, t.reject_split_bps, s.package_id, s.status AS settlement_status,
             s.worker_wallet, s.funder_wallet, s.release_transaction_bytes_base64, s.release_expected_digest, s.release_sender,
             s.score_id, s.score_sender
      FROM tasks t JOIN settlements s ON s.task_id = t.id WHERE t.id = ${taskId} AND t.assigned_worker_id = ${worker.id}
      FOR UPDATE OF t, s
    ` as Row[];
    assert(snapshot, 404, 'task_not_found', 'Task was not found for this worker.');
    assertMainnetUsdc(snapshot);
    if (snapshot.release_transaction_bytes_base64 && snapshot.release_expected_digest) {
      assert(sameAddress(snapshot.release_sender, worker.wallet_address), 409, 'timeout_claim_not_pending', 'A different release transaction is already frozen for this task.');
      return actionResult(taskId, { digest: snapshot.release_expected_digest, transactionBytesBase64: snapshot.release_transaction_bytes_base64, transactionJson: '' }, config, { state: snapshot.state, permissionless: true, consentRequired: false });
    }
    assert((snapshot.state === 'SUBMITTED' || snapshot.state === 'REVIEW') && snapshot.settlement_status === 'SUBMITTED' && snapshot.package_id === config.packageId && snapshot.job_id, 409, 'timeout_claim_not_ready', 'The task has no delivered job ready for timeout release.');
    let job: Job;
    try {
      job = await readT2000Job(config.client, snapshot.job_id, config.packageId);
    } catch {
      throw new HttpError(400, 'job_read_failed', 'The t2000 job could not be read.');
    }
    assert(job.state === 'delivered' && job.deliveredAtMs !== null && job.deliveredAtMs + job.reviewWindowMs <= Date.now(), 409, 'review_window_open', 'The t2000 review window has not elapsed.');
    const scoreId = await settlementSellerScore(tx, taskId, config, worker.wallet_address, snapshot.score_id, snapshot.score_sender);
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000ReleaseTx(snapshot.job_id, scoreId), worker.wallet_address, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Timeout release transaction could not be prepared.');
    }
    await tx`UPDATE settlements SET release_transaction_json = ${tx.json(frozenJson(frozen))}, release_transaction_bytes_base64 = ${frozen.transactionBytesBase64}, release_expected_digest = ${frozen.digest}, release_sender = ${worker.wallet_address} WHERE task_id = ${taskId}`;
    return actionResult(taskId, frozen, config, { state: snapshot.state, permissionless: true, consentRequired: false, reviewWindowMs: job.reviewWindowMs });
  });
}

export async function confirmTimeoutClaim(session: Session, taskId: string, digest: string) {
  return confirmReleaseWithSender(session, taskId, digest, 'timeout');
}

export async function buildRejectTransaction(session: Session, taskId: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  assert(config.registryId, 503, 'registry_not_configured', 'The t2000 agent registry is required for rejection.');
  const registryId = config.registryId;
  return db().begin(async (tx) => {
    const [snapshot] = await tx`
      SELECT t.state, t.review_decision, t.job_id, t.assigned_worker_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only,
             t.review_window_ms, t.reject_split_bps,
             a.id AS approval_id, a.status AS approval_status, a.amount_atomic AS approved_amount_atomic,
             a.asset AS approved_asset, a.network AS approved_network, a.decimals AS approved_decimals,
             a.review_window_ms AS approved_review_window_ms, a.reject_split_bps AS approved_reject_split_bps,
             a.worker_id AS approved_worker, a.worker_wallet AS approved_worker_wallet, a.owner_wallet AS approved_owner_wallet,
             a.expires_at, a.consented_at, a.transaction_bytes_base64, a.expected_digest,
             o.wallet_address AS current_owner_wallet, w.wallet_address AS current_worker_wallet,
             s.package_id, s.status AS settlement_status, s.worker_wallet, s.funder_wallet, s.brief_hash,
             s.rejection_digest, s.reject_expected_digest, s.score_id, s.score_sender
      FROM tasks t JOIN approvals a ON a.task_id = t.id AND a.kind = 'REJECT'
      JOIN owners o ON o.id = t.owner_id JOIN workers w ON w.id = t.assigned_worker_id JOIN settlements s ON s.task_id = t.id
      WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1
      FOR UPDATE OF t, a, o, w, s
    ` as Row[];
    assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
    assertMainnetUsdc(snapshot);
    if (snapshot.approval_status === 'ISSUED' && snapshot.transaction_bytes_base64 && snapshot.expected_digest) return actionResult(taskId, { digest: snapshot.expected_digest, transactionBytesBase64: snapshot.transaction_bytes_base64, transactionJson: '' }, config, { state: snapshot.state });
    assert((snapshot.state === 'REVIEW' || snapshot.state === 'SUBMITTED') && snapshot.review_decision === 'REQUEST_REVIEW' && snapshot.settlement_status === 'SUBMITTED' && snapshot.package_id === config.packageId, 409, 'reject_not_ready', 'A submission requesting review and fresh owner authorization are required.');
    assert(snapshot.approval_status === 'APPROVED' && snapshot.consented_at && new Date(snapshot.expires_at).getTime() > Date.now(), 409, 'owner_approval_required', 'Fresh owner approval for rejection is required.');
    assert(String(snapshot.amount_atomic) === String(snapshot.approved_amount_atomic) && snapshot.approved_worker === snapshot.assigned_worker_id, 409, 'approval_snapshot_changed', 'Task amount or worker changed after owner approval.');
    assert(snapshot.asset === snapshot.approved_asset && snapshot.network === snapshot.approved_network && Number(snapshot.decimals) === Number(snapshot.approved_decimals), 409, 'approval_snapshot_changed', 'Payment asset changed after owner approval.');
    assert(Number(snapshot.review_window_ms) === Number(snapshot.approved_review_window_ms) && Number(snapshot.reject_split_bps) === Number(snapshot.approved_reject_split_bps), 409, 'approval_snapshot_changed', 'Immutable t2000 terms changed after owner approval.');
    assert(sameAddress(snapshot.current_owner_wallet, snapshot.approved_owner_wallet) && sameAddress(snapshot.current_owner_wallet, snapshot.funder_wallet), 409, 'approval_snapshot_changed', 'Owner wallet changed after approval.');
    assert(sameAddress(snapshot.current_worker_wallet, snapshot.approved_worker_wallet) && sameAddress(snapshot.current_worker_wallet, snapshot.worker_wallet), 409, 'approval_snapshot_changed', 'Worker wallet changed after approval.');
    assert(snapshot.job_id, 409, 'job_missing', 'Confirmed t2000 job ID is missing.');
    const scoreId = await settlementSellerScore(tx, taskId, config, snapshot.current_worker_wallet, snapshot.score_id, snapshot.score_sender);
    let buyerScoreId: string | undefined;
    let buyerIsRegistered: boolean;
    try {
      buyerIsRegistered = await isT2000RegisteredAgent(config.client, registryId, snapshot.current_owner_wallet);
    } catch {
      throw new HttpError(503, 'registry_membership_unavailable', 'The t2000 Agent-ID registry could not be read; rejection is unavailable.');
    }
    if (buyerIsRegistered) {
      let buyerScore;
      try {
        buyerScore = await readT2000Score(config.client, snapshot.current_owner_wallet, config.scoreBoardId);
      } catch {
        throw new HttpError(503, 'buyer_score_unavailable', 'The registered buyer score could not be read; rejection is unavailable.');
      }
      assert(buyerScore.exists, 409, 'buyer_score_setup_required', 'The registered buyer needs a t2000 score before rejection.');
      buyerScoreId = buyerScore.id;
    }
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000RejectTx(snapshot.job_id, scoreId, registryId, buyerScoreId), snapshot.current_owner_wallet, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Rejection transaction could not be prepared.');
    }
    await tx`UPDATE approvals SET status = 'ISSUED', transaction_json = ${tx.json(frozenJson(frozen))}, transaction_bytes_base64 = ${frozen.transactionBytesBase64}, expected_digest = ${frozen.digest} WHERE id = ${snapshot.approval_id}`;
    await tx`UPDATE settlements SET reject_transaction_json = ${tx.json(frozenJson(frozen))}, reject_transaction_bytes_base64 = ${frozen.transactionBytesBase64}, reject_expected_digest = ${frozen.digest} WHERE task_id = ${taskId}`;
    return actionResult(taskId, frozen, config, { state: snapshot.state, amountAtomic: amount(snapshot.amount_atomic), terms: { reviewWindowMs: Number(snapshot.review_window_ms), rejectSplitBps: Number(snapshot.reject_split_bps) } });
  });
}

export async function confirmReject(session: Session, taskId: string, digest: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  const [snapshot] = await db()`
    SELECT t.state, t.agent_id, t.amount_atomic, t.asset, t.network, t.decimals, t.legacy_read_only, t.job_id,
           t.review_window_ms, t.reject_split_bps, s.package_id, s.status AS settlement_status, s.funder_wallet, s.worker_wallet,
           s.brief_hash, s.deadline AS settlement_deadline, s.review_window_ms AS settlement_review_window_ms,
           s.reject_split_bps AS settlement_reject_split_bps, s.rejection_digest, s.reject_expected_digest
    FROM tasks t JOIN settlements s ON s.task_id = t.id WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
  assertMainnetUsdc(snapshot);
  if (snapshot.state === 'REJECTED' && snapshot.rejection_digest === digest) return { taskId, state: 'REJECTED', digest, settlement: settlementDto(await latestSettlement(taskId)) };
  assert((snapshot.state === 'REVIEW' || snapshot.state === 'SUBMITTED') && snapshot.settlement_status === 'SUBMITTED' && snapshot.package_id === config.packageId && snapshot.job_id, 409, 'reject_not_pending', 'Task has no active rejection attempt.');
  assert(snapshot.reject_expected_digest === digest, 409, 'reject_digest_mismatch', 'Digest does not match the frozen rejection transaction for this task.');
  const receipt = await validateJobReceipt({
    config, digest, expectedSender: snapshot.funder_wallet, expectedState: 'rejected', jobId: snapshot.job_id,
    expected: receiptExpected({ ...snapshot, amount_atomic: snapshot.amount_atomic, brief_hash: snapshot.brief_hash, deadline: snapshot.settlement_deadline, review_window_ms: snapshot.settlement_review_window_ms, reject_split_bps: snapshot.settlement_reject_split_bps }, snapshot.funder_wallet, snapshot.worker_wallet),
  });
  const settlement = await settleTerminal({ taskId, digest, finalState: 'REJECTED', job: receipt.job, ownerId: owner.id });
  return { taskId, state: 'REJECTED', digest, jobId: receipt.jobId, settlement: settlementDto(settlement) };
}

async function settleTerminal(input: { taskId: string; digest: string; finalState: FinalState; job: Job; ownerId?: string }) {
  return db().begin(async (tx) => {
    const [task] = await tx`
      SELECT id, owner_id, agent_id, state, amount_atomic, reject_split_bps
      FROM tasks WHERE id = ${input.taskId} ${input.ownerId ? tx`AND owner_id = ${input.ownerId}` : tx``} FOR UPDATE
    ` as Row[];
    assert(task, 404, 'task_not_found', 'Task was not found.');
    const [settlement] = await tx`SELECT * FROM settlements WHERE task_id = ${input.taskId} FOR UPDATE` as Row[];
    assert(settlement, 409, 'settlement_missing', 'The payment settlement record is missing.');
    assert(String(task.amount_atomic) === String(settlement.amount_atomic), 409, 'settlement_snapshot_changed', 'The task amount and frozen settlement amount differ.');
    const digestColumn = input.finalState === 'PAID' ? settlement.release_digest : input.finalState === 'REFUNDED' ? settlement.refund_digest : settlement.rejection_digest;
    if (task.state === input.finalState && digestColumn === input.digest) return settlement;
    const allowed = input.finalState === 'REFUNDED' ? task.state === 'FUNDED' : task.state === 'SUBMITTED' || task.state === 'REVIEW';
    assert(allowed, 409, 'settlement_terminal', 'Task has already reached a different state.');
    const grossAtomic = String(settlement.amount_atomic);
    const finalAmounts = input.finalState === 'REFUNDED'
      ? { sellerGrossAtomic: '0', feeAtomic: '0', netAtomic: '0', feeBps: null as number | null }
      : settledAmounts(grossAtomic, input.job, input.finalState === 'REJECTED'
        ? Number(settlement.reject_split_bps ?? DEFAULT_REJECT_SPLIT_BPS)
        : undefined);
    const sellerSpentAtomic = input.finalState === 'PAID'
      ? grossAtomic
      : input.finalState === 'REJECTED' ? finalAmounts.sellerGrossAtomic : '0';
    const agentUpdate = input.finalState === 'PAID' || input.finalState === 'REJECTED'
      ? await tx`UPDATE agents SET reserved_atomic = reserved_atomic - ${task.amount_atomic}, spent_atomic = spent_atomic + ${sellerSpentAtomic} WHERE id = ${task.agent_id} AND reserved_atomic >= ${task.amount_atomic}`
      : await tx`UPDATE agents SET reserved_atomic = reserved_atomic - ${task.amount_atomic} WHERE id = ${task.agent_id} AND reserved_atomic >= ${task.amount_atomic}`;
    assert(agentUpdate.count === 1, 409, 'budget_reservation_missing', 'Task budget reservation could not be reconciled.');
    if (input.finalState === 'PAID') {
      await tx`UPDATE tasks SET state = 'PAID', release_digest = ${input.digest} WHERE id = ${input.taskId}`;
      await tx`UPDATE settlements SET status = 'PAID', release_digest = ${input.digest}, fee_atomic = ${finalAmounts.feeAtomic}, net_atomic = ${finalAmounts.netAtomic}, fee_bps = ${finalAmounts.feeBps}, settled_at = COALESCE(settled_at, now()) WHERE task_id = ${input.taskId}`;
      await tx`UPDATE approvals SET status = 'CONSUMED' WHERE task_id = ${input.taskId} AND kind = 'RELEASE' AND status = 'ISSUED'`;
    } else if (input.finalState === 'REFUNDED') {
      await tx`UPDATE tasks SET state = 'REFUNDED', refund_digest = ${input.digest} WHERE id = ${input.taskId}`;
      await tx`UPDATE settlements SET status = 'REFUNDED', refund_digest = ${input.digest}, fee_atomic = '0', net_atomic = '0', fee_bps = 0, settled_at = COALESCE(settled_at, now()) WHERE task_id = ${input.taskId}`;
    } else {
      await tx`UPDATE tasks SET state = 'REJECTED', rejection_digest = ${input.digest} WHERE id = ${input.taskId}`;
      await tx`UPDATE settlements SET status = 'REJECTED', rejection_digest = ${input.digest}, fee_atomic = ${finalAmounts.feeAtomic}, net_atomic = ${finalAmounts.netAtomic}, fee_bps = ${finalAmounts.feeBps}, settled_at = COALESCE(settled_at, now()) WHERE task_id = ${input.taskId}`;
      await tx`UPDATE approvals SET status = 'CONSUMED' WHERE task_id = ${input.taskId} AND kind = 'REJECT' AND status = 'ISSUED'`;
    }
    await tx`INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail) VALUES ('chain', NULL, ${input.taskId}, ${input.finalState === 'PAID' ? 'released' : input.finalState === 'REFUNDED' ? 'refunded' : 'rejected'}, ${tx.json({ grossAtomic, sellerGrossAtomic: finalAmounts.sellerGrossAtomic, feeAtomic: finalAmounts.feeAtomic, netAtomic: finalAmounts.netAtomic, feeBps: finalAmounts.feeBps })})`;
    const [updated] = await tx`SELECT * FROM settlements WHERE task_id = ${input.taskId}` as Row[];
    return updated;
  });
}

export async function buildRatingTransaction(session: Session, taskId: string, stars: number) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  assert(Number.isInteger(stars) && stars >= 1 && stars <= 5, 400, 'rating_invalid', 'Rating must be an integer from 1 to 5.');
  return db().begin(async (tx) => {
    const [snapshot] = await tx`
      SELECT t.state, t.owner_id, t.job_id, t.asset, t.network, t.decimals, t.legacy_read_only,
             w.wallet_address AS worker_wallet, s.status AS settlement_status, s.job_id AS settlement_job_id,
             s.amount_atomic, s.asset AS settlement_asset, s.network AS settlement_network,
             s.decimals AS settlement_decimals
      FROM tasks t JOIN workers w ON w.id = t.assigned_worker_id JOIN settlements s ON s.task_id = t.id
      WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
      FOR UPDATE OF t, s
    ` as Row[];
    assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
    const [rating] = await tx`
      SELECT reviewer_wallet, stars, transaction_bytes_base64, expected_digest, digest, confirmed_at
      FROM ratings WHERE task_id = ${taskId}
      FOR UPDATE
    ` as Row[];
    if (rating) Object.assign(snapshot, rating);
    assertMainnetUsdc(snapshot);
    assert((snapshot.state === 'PAID' || snapshot.state === 'REJECTED') && snapshot.settlement_status === snapshot.state, 409, 'rating_not_ready', 'A settled task is required before rating.');
    assert(snapshot.job_id === snapshot.settlement_job_id && snapshot.job_id, 409, 'job_missing', 'Confirmed t2000 job ID is missing.');
    if (!snapshot.confirmed_at && snapshot.expected_digest && snapshot.transaction_bytes_base64) {
      assert(sameAddress(snapshot.reviewer_wallet, owner.wallet_address) && Number(snapshot.stars) === stars, 409, 'rating_already_pending', 'A different rating is already frozen for this task.');
      return actionResult(taskId, { digest: snapshot.expected_digest, transactionBytesBase64: snapshot.transaction_bytes_base64, transactionJson: '' }, config, { state: 'RATING', stars, jobId: snapshot.job_id });
    }
    assert(!snapshot.confirmed_at, 409, 'rating_already_recorded', 'This task already has a confirmed rating.');
    let score;
    try {
      score = await readT2000Score(config.client, snapshot.worker_wallet, config.scoreBoardId);
    } catch {
      genericBuildFailure('score_unavailable', 'The worker t2000 score could not be read.');
    }
    let frozen: FrozenEscrowTransaction;
    try {
      frozen = await freezeT2000Transaction(buildT2000RatingTx(snapshot.job_id, stars, score.exists ? score.id : null, config.scoreBoardId), owner.wallet_address, config.client);
    } catch {
      genericBuildFailure('transaction_build_failed', 'Rating transaction could not be prepared.');
    }
    await tx`
      INSERT INTO ratings (task_id, reviewer_wallet, stars, digest, network, coin_type, transaction_json, transaction_bytes_base64, expected_digest)
      VALUES (${taskId}, ${owner.wallet_address}, ${stars}, ${frozen.digest}, ${config.network}, ${config.coinType}, ${tx.json(frozenJson(frozen))}, ${frozen.transactionBytesBase64}, ${frozen.digest})
      ON CONFLICT (task_id) DO UPDATE SET reviewer_wallet = EXCLUDED.reviewer_wallet, stars = EXCLUDED.stars, digest = EXCLUDED.digest, network = EXCLUDED.network, coin_type = EXCLUDED.coin_type, transaction_json = EXCLUDED.transaction_json, transaction_bytes_base64 = EXCLUDED.transaction_bytes_base64, expected_digest = EXCLUDED.expected_digest
    `;
    return actionResult(taskId, frozen, config, { state: 'RATING', stars, jobId: snapshot.job_id });
  });
}

export async function confirmRating(session: Session, taskId: string, digest: string) {
  const owner = await ownerForSession(session);
  const config = paymentConfig();
  const [snapshot] = await db()`
    SELECT t.state, t.job_id, t.asset, t.network, t.decimals, t.legacy_read_only,
           r.reviewer_wallet, r.stars, r.expected_digest, r.digest, r.confirmed_at
    FROM tasks t LEFT JOIN ratings r ON r.task_id = t.id
    WHERE t.id = ${taskId} AND t.owner_id = ${owner.id}
  ` as Row[];
  assert(snapshot, 404, 'task_not_found', 'Task was not found for this owner.');
  assertMainnetUsdc(snapshot);
  if (snapshot.confirmed_at && snapshot.digest === digest) return { taskId, state: 'RATED', digest, stars: Number(snapshot.stars), jobId: snapshot.job_id };
  assert(snapshot.expected_digest === digest && snapshot.reviewer_wallet && sameAddress(snapshot.reviewer_wallet, owner.wallet_address), 409, 'rating_digest_mismatch', 'Digest does not match the frozen rating transaction.');
  let receipt;
  try {
    receipt = await validateT2000RatingReceipt({ client: config.client, digest, expectedSender: owner.wallet_address, jobId: snapshot.job_id, packageId: config.packageId });
  } catch {
    throw new HttpError(400, 'rating_receipt_invalid', 'The finalized rating transaction did not match the settled t2000 job.');
  }
  await db()`UPDATE ratings SET digest = ${digest}, confirmed_at = COALESCE(confirmed_at, now()) WHERE task_id = ${taskId} AND expected_digest = ${digest} AND confirmed_at IS NULL`;
  return { taskId, state: 'RATED', digest, stars: Number(snapshot.stars), jobId: receipt.jobId };
}

export async function getTaskRating(taskId: string) {
  const [row] = await db()`SELECT task_id, reviewer_wallet, stars, digest, network, coin_type, created_at, confirmed_at FROM ratings WHERE task_id = ${taskId} AND confirmed_at IS NOT NULL` as Row[];
  return row ? { taskId: row.task_id, reviewerWallet: row.reviewer_wallet, stars: Number(row.stars), digest: row.digest, network: row.network, coinType: row.coin_type, createdAt: new Date(row.created_at).toISOString(), confirmedAt: new Date(row.confirmed_at).toISOString() } : null;
}
