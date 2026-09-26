import type postgres from 'postgres';
import { db } from './db';
import { assert, HttpError } from './errors';
import { sha256, uuid } from './security';
import type { Session } from './session';
import type { AgentToolName, TaskFieldsInput } from './schemas';
import { ownerForSession, workerForSession } from './identity';
import { createAuthorizedAgent, assertAgentPostingAuthorized, isAgentPostingAuthorized } from './profile-authorization';
import { assertSufficientPostingBalance, type PostingBalanceDependency } from './posting-balance';
import { readT2000FeeBps, t2000Config } from '../sui/t2000';

const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_REVIEW_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_REJECT_SPLIT_BPS = 5_000;
export const T2000_FEE_QUOTE_BPS = 250;

async function currentT2000FeeQuoteBps(): Promise<number> {
  try {
    const config = t2000Config();
    return await readT2000FeeBps(config.client, config.feeConfigId);
  } catch {
    throw new HttpError(503, 'fee_quote_unavailable', 'The current t2000 protocol fee could not be read.');
  }
}

function assertTaskWritable(task: Record<string, any>): void {
  assert(task.asset === 'USDC' && task.network === 'mainnet' && Number(task.decimals) === 6 && task.legacy_read_only !== true,
    410, 'legacy_payment_read_only', 'This historical SUI/testnet task is read-only and cannot enter a t2000 payment.');
}

export type AgentPrincipal = {
  id: string;
  ownerId: string;
  name: string;
  scopes: AgentToolName[];
  categories: string[];
  maxTaskAtomic?: string;
  totalBudgetAtomic?: string;
  /** @deprecated Compatibility for pre-003 direct test fixtures only. */
  maxTaskMist?: string;
  /** @deprecated Compatibility for pre-003 direct test fixtures only. */
  totalBudgetMist?: string;
};

export async function getBrowserState(session: Session) {
  const [worker, owner] = await Promise.all([
    session.workerId ? workerForSession(session).catch(() => null) : Promise.resolve(null),
    session.ownerId ? ownerForSession(session).catch(() => null) : Promise.resolve(null),
  ]);
  const agents = owner ? await db()`
    SELECT id, owner_id, name, categories, scopes, asset, network, decimals, max_task_atomic, total_budget_atomic, reserved_atomic, spent_atomic, active,
           authorization_required, authorization_policy_hash, authorization_wallet,
           authorization_signature, authorization_message, authorized_at
    FROM agents WHERE owner_id = ${owner.id} ORDER BY created_at
  ` : [];
  const publicTasks = await db()`
    SELECT t.*, w.display_name AS worker_name, w.wallet_address AS worker_wallet
    FROM tasks t LEFT JOIN workers w ON w.id = t.assigned_worker_id
    WHERE (t.state = 'OPEN' AND t.deadline > now())
       OR t.owner_id = ${owner?.id ?? null}
       OR t.assigned_worker_id = ${worker?.id ?? null}
    ORDER BY CASE WHEN t.state = 'OPEN' THEN 0 ELSE 1 END, t.created_at DESC LIMIT 100
  `;
  const evidenceRows = await db()`
    SELECT e.id, e.task_id, e.media_type, e.byte_length, e.sha256, e.report, e.uploaded_at
    FROM evidence e JOIN tasks t ON t.id = e.task_id
    WHERE t.owner_id = ${owner?.id ?? null} OR t.assigned_worker_id = ${worker?.id ?? null}
  `;
  const evidenceByTask = new Map(evidenceRows.map((row) => [row.task_id, safeEvidence(row)]));
  const approvals = owner ? await db()`
    SELECT a.id, a.task_id, a.kind, a.status, a.amount_atomic, a.asset, a.network, a.decimals, a.review_window_ms, a.reject_split_bps, a.fee_quote_bps, a.fee_quote_atomic, a.net_quote_atomic, a.worker_wallet, a.owner_wallet, a.expires_at,
           t.title, t.brief, t.area, w.display_name AS worker_name
    FROM approvals a
    JOIN tasks t ON t.id = a.task_id
    JOIN workers w ON w.id = a.worker_id
    WHERE a.owner_id = ${owner.id} AND a.status IN ('PENDING','APPROVED','ISSUED')
    ORDER BY a.created_at DESC LIMIT 50
  ` : [];

  const worldWorkerConfigReady = Boolean(
    process.env.WORLD_ID_APP_ID
      && process.env.WORLD_ID_RP_ID
      && process.env.WORLD_ID_RP_SIGNING_KEY
      && process.env.WORLD_ID_WORKER_ACTION
      && process.env.WORLD_ID_ENVIRONMENT
      && (process.env.WORLD_ID_ENVIRONMENT === 'production' || process.env.WORLD_ID_STAGING_VERIFICATION_TOKEN),
  );
  const worldIdentityEnvironment = ['production', 'staging', 'sandbox'].includes(process.env.WORLD_ID_ENVIRONMENT ?? '')
    ? process.env.WORLD_ID_ENVIRONMENT
    : null;
  let t2000Configured = false;
  try {
    t2000Config();
    t2000Configured = true;
  } catch {
    // Payment actions fail closed independently; browser state only reports
    // whether the canonical mainnet configuration is locally valid.
  }
  return {
    session: {
      worker: worker ? {
        id: worker.id,
        displayName: worker.display_name,
        category: worker.category,
        area: worker.area,
        skills: worker.skills,
        status: worker.status,
        walletAddress: worker.wallet_address,
        walletVerified: !!worker.wallet_verified_at,
        worldVerified: !!worker.idkit_verified_at,
      } : null,
      owner: owner ? { id: owner.id, walletAddress: owner.wallet_address, walletVerified: !!owner.wallet_verified_at } : null,
    },
    config: {
      appUrl: process.env.APP_URL ?? null,
      suiNetwork: process.env.SUI_NETWORK ?? 'mainnet',
      suiEscrowConfigured: t2000Configured,
      workerVerificationConfigured: worldWorkerConfigReady,
      worldIdentityEnvironment,
      ownerAuthenticationConfigured: !!(process.env.WORLD_AGENTS_ISSUER && process.env.WORLD_AGENTS_CLIENT_ID && process.env.WORLD_AGENTS_CLIENT_SECRET && process.env.WORLD_AGENTS_REDIRECT_URI),
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      categories: agent.categories,
      maxTaskAtomic: String(agent.max_task_atomic),
      totalBudgetAtomic: String(agent.total_budget_atomic),
      reservedAtomic: String(agent.reserved_atomic),
      spentAtomic: String(agent.spent_atomic),
      availableAtomic: String(BigInt(agent.total_budget_atomic) - BigInt(agent.reserved_atomic) - BigInt(agent.spent_atomic)),
      asset: agent.asset,
      network: agent.network,
      decimals: Number(agent.decimals),
      active: agent.active,
      authorizationRequired: !isAgentPostingAuthorized(agent, owner?.wallet_address ?? ''),
    })),
    tasks: publicTasks.map((task) => {
      const isParticipant = task.owner_id === owner?.id || task.assigned_worker_id === worker?.id;
      const canReadOpenBrief = task.state === 'OPEN'
        && worker?.status === 'VERIFIED'
        && !!worker.wallet_address
        && !!worker.wallet_verified_at
        && worker.category === task.category;
      return { ...publicTask(task, { includePrivate: isParticipant || canReadOpenBrief }), evidence: evidenceByTask.get(task.id) ?? null };
    }),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      taskId: approval.task_id,
      kind: approval.kind,
      status: approval.status,
      amountAtomic: String(approval.amount_atomic),
      asset: approval.asset,
      network: approval.network,
      decimals: Number(approval.decimals),
      reviewWindowMs: Number(approval.review_window_ms),
      rejectSplitBps: Number(approval.reject_split_bps),
      feeQuoteBps: approval.fee_quote_bps == null ? null : Number(approval.fee_quote_bps),
      feeQuoteAtomic: approval.fee_quote_atomic == null ? null : String(approval.fee_quote_atomic),
      netQuoteAtomic: approval.net_quote_atomic == null ? null : String(approval.net_quote_atomic),
      workerName: approval.worker_name,
      workerWallet: approval.worker_wallet,
      ownerWallet: approval.owner_wallet,
      expiresAt: new Date(approval.expires_at).toISOString(),
      task: { title: approval.title, brief: approval.brief, area: approval.area },
    })),
  };
}

export async function authenticateAgent(request: Request): Promise<AgentPrincipal> {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer (gw_live_[A-Za-z0-9_-]{30,})$/.exec(authorization);
  assert(match, 401, 'agent_credential_required', 'A valid agent bearer credential is required.');
  const [agent] = await db()`
    SELECT id, owner_id, name, scopes, categories, max_task_atomic, total_budget_atomic
    FROM agents WHERE api_key_hash = ${sha256(match[1])} AND active = true
  `;
  assert(agent, 401, 'agent_credential_invalid', 'Agent credential is invalid or disabled.');
  return {
    id: agent.id,
    ownerId: agent.owner_id,
    name: agent.name,
    scopes: agent.scopes,
    categories: agent.categories,
    maxTaskAtomic: String(agent.max_task_atomic),
    totalBudgetAtomic: String(agent.total_budget_atomic),
  };
}

export async function createAgent(session: Session, input: {
  name: string;
  categories: string[];
  maxTaskAtomic: string;
  totalBudgetAtomic: string;
  challengeId: string;
  signature: string;
}) {
  return createAuthorizedAgent(session, input);
}

export async function createTaskForAgent(
  agent: AgentPrincipal,
  fields: TaskFieldsInput,
  client: postgres.Sql = db(),
  balanceDependency?: PostingBalanceDependency,
) {
  assertScope(agent, 'create_task');
  // Keep old direct callers source-compatible while the validated request
  // schemas expose only amountAtomic. New rows are always tagged USDC below.
  const amountAtomic = fields.amountAtomic ?? ('amountMist' in fields ? fields.amountMist : undefined);
  assert(amountAtomic && /^[1-9][0-9]{0,18}$/.test(amountAtomic), 400, 'invalid_amount', 'Task amount must be a positive atomic integer.');
  const deadline = new Date(fields.deadline);
  const remaining = deadline.getTime() - Date.now();
  assert(Number.isFinite(deadline.getTime()) && remaining >= 60_000 && remaining <= 30 * 24 * 60 * 60 * 1000,
    400, 'invalid_deadline', 'Task deadline must be between one minute and thirty days from now.');
  const taskId = uuid();
  try {
    return await client.begin(async (tx) => {
      const [owner] = await tx`
        SELECT id, wallet_address, wallet_verified_at
        FROM owners
        WHERE id = ${agent.ownerId}
        FOR UPDATE
      `;
      assert(owner, 404, 'owner_missing', 'Owner account was not found.');
      assert(owner.wallet_address && owner.wallet_verified_at, 409, 'owner_wallet_required', 'Link and verify a signed owner funding wallet before posting a task.');

      // Lock the complete agent row before checking the one-time profile
      // authorization and reserving any amount.  The owner lock above also
      // serializes creates made through different agents belonging to one
      // owner.
      const [agentRow] = await tx`
        SELECT *
        FROM agents
        WHERE id = ${agent.id} AND owner_id = ${owner.id} AND active = true
        FOR UPDATE
      `;
      assert(agentRow, 403, 'agent_policy_rejected', 'Agent is not active for this owner.');
      assertAgentPostingAuthorized(agentRow, owner.wallet_address);
      const agentAmount = BigInt(amountAtomic);
      const agentMaxTask = BigInt(String(agentRow.max_task_atomic));
      const agentTotalBudget = BigInt(String(agentRow.total_budget_atomic));
      const agentReserved = BigInt(String(agentRow.reserved_atomic ?? 0));
      const agentSpent = BigInt(String(agentRow.spent_atomic ?? 0));
      assert(
        agentAmount <= agentMaxTask
          && agentSpent + agentReserved + agentAmount <= agentTotalBudget
          && Array.isArray(agentRow.categories)
          && agentRow.categories.includes(fields.category),
        403,
        'agent_policy_rejected',
        'Task exceeds the agent category, per-task, or remaining budget policy.',
      );

      const [outstanding] = await tx`
        SELECT COALESCE(SUM(amount_atomic), 0)::text AS outstanding_atomic
        FROM tasks
        WHERE owner_id = ${owner.id}
          AND asset = 'USDC' AND network = 'mainnet' AND decimals = 6 AND legacy_read_only = false
          AND state IN ('OPEN', 'ASSIGNED', 'FUNDING')
      `;
      const outstandingAtomic = String(outstanding?.outstanding_atomic ?? '');
      assert(/^(0|[1-9][0-9]*)$/.test(outstandingAtomic), 503, 'owner_balance_unavailable', 'Outstanding owner task balances could not be verified.');
      const requiredAtomic = (BigInt(outstandingAtomic) + BigInt(amountAtomic)).toString();
      await assertSufficientPostingBalance(owner.wallet_address, requiredAtomic, balanceDependency);

      const [reserved] = await tx`
        UPDATE agents
        SET reserved_atomic = reserved_atomic + ${amountAtomic}
        WHERE id = ${agent.id} AND owner_id = ${agent.ownerId} AND active = true
          AND asset = 'USDC' AND network = 'mainnet' AND decimals = 6 AND legacy_read_only = false
          AND ${amountAtomic}::bigint <= max_task_atomic
          AND spent_atomic + reserved_atomic + ${amountAtomic}::bigint <= total_budget_atomic
          AND ${fields.category} = ANY(categories)
        RETURNING id, owner_id
      `;
      assert(reserved, 403, 'agent_policy_rejected', 'Task exceeds the agent category, per-task, or remaining budget policy.');
      await tx`
        INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, asset, network, decimals, legacy_read_only, review_window_ms, reject_split_bps, deadline)
        VALUES (${taskId}, ${reserved.owner_id}, ${agent.id}, ${fields.title}, ${fields.brief}, ${fields.category}, ${fields.area}, ${tx.json(fields.rubric)}, ${amountAtomic}, 'USDC', 'mainnet', 6, false, ${fields.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS}, ${fields.rejectSplitBps ?? DEFAULT_REJECT_SPLIT_BPS}, ${deadline})
      `;
      await tx`
        INSERT INTO audit_events (actor_type, actor_id, task_id, event_type)
        VALUES ('agent', ${agent.id}, ${taskId}, 'task_created')
      `;
      const [row] = await tx`SELECT * FROM tasks WHERE id = ${taskId}`;
      return publicTask(row);
    });
  } catch (error) {
    if (isCheckViolation(error)) throw new HttpError(403, 'agent_budget_exceeded', 'Task exceeds the agent budget policy.');
    throw error;
  }
}

export async function ownerCreateTask(session: Session, agentId: string, fields: TaskFieldsInput) {
  const owner = await ownerForSession(session);
  const agent = await ownedAgent(owner.id, agentId, 'create_task');
  return createTaskForAgent(agent, fields);
}

export async function searchWorkers(agent: AgentPrincipal, filters: { category?: string; area?: string }) {
  assertScope(agent, 'search_workers');
  assert(!filters.category || agent.categories.includes(filters.category), 403, 'agent_policy_rejected', 'Agent cannot search this category.');
  const workers = await db()`
    SELECT id, display_name, category, area, skills, wallet_address IS NOT NULL AS wallet_linked
    FROM workers
    WHERE status = 'VERIFIED' AND wallet_address IS NOT NULL
      AND category = ANY(${db().array(agent.categories)})
      AND (${filters.category ?? null}::text IS NULL OR category = ${filters.category ?? null})
      AND (${filters.area ?? null}::text IS NULL OR area ILIKE ${filters.area ? `%${filters.area}%` : null})
    ORDER BY created_at DESC LIMIT 100
  `;
  return workers.map((worker) => ({
    id: worker.id,
    displayName: worker.display_name,
    category: worker.category,
    area: worker.area,
    skills: worker.skills,
  }));
}

export async function acceptTask(session: Session, taskId: string) {
  // Worker selection now happens through task_applications. Keep this export
  // so an old route fails closed while the parent rewires its action switch.
  void session;
  void taskId;
  throw new HttpError(410, 'accept_task_disabled', 'Direct task acceptance is disabled; apply and wait for worker selection.');
}

export async function requestHire(agent: AgentPrincipal, taskId: string) {
  assertScope(agent, 'request_hire');
  return createBoundApproval(agent, taskId, 'HIRE');
}

export async function reviewSubmission(agent: AgentPrincipal, input: { taskId: string; decision: 'accept' | 'request_review'; note?: string }) {
  assertScope(agent, 'review_submission');
  const state = input.decision === 'accept' ? 'SUBMITTED' : 'REVIEW';
  const decision = input.decision === 'accept' ? 'ACCEPT' : 'REQUEST_REVIEW';
  const result = await db().begin(async (tx) => {
    const [task] = await tx`SELECT id, state, asset, network, decimals, legacy_read_only FROM tasks WHERE id = ${input.taskId} AND agent_id = ${agent.id} FOR UPDATE`;
    assert(task, 404, 'task_not_found', 'Task was not found for this agent.');
    assertTaskWritable(task);
    assert(task.state === 'SUBMITTED' || task.state === 'REVIEW', 409, 'task_not_submitted', 'Task has no submission to review.');
    const [release] = await tx`
      SELECT id FROM approvals
      WHERE task_id = ${input.taskId} AND kind = 'RELEASE' AND status = 'ISSUED'
      FOR UPDATE
    `;
    assert(!release, 409, 'release_already_issued', 'The accepted review is frozen because release transaction bytes have already been issued.');
    await tx`
      UPDATE tasks SET state = ${state}, review_decision = ${decision}, review_note = ${input.note ?? null}
      WHERE id = ${input.taskId}
    `;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail)
      VALUES ('agent', ${agent.id}, ${input.taskId}, 'submission_reviewed', ${tx.json({ decision })})
    `;
    return { taskId: input.taskId, state, decision };
  });
  return result;
}

export async function ownerReviewSubmission(session: Session, agentId: string, input: { taskId: string; decision: 'accept' | 'request_review'; note?: string }) {
  const owner = await ownerForSession(session);
  const agent = await ownedAgent(owner.id, agentId, 'review_submission');
  return reviewSubmission(agent, input);
}

export async function requestRelease(agent: AgentPrincipal, taskId: string) {
  assertScope(agent, 'request_release');
  return createBoundApproval(agent, taskId, 'RELEASE');
}

/** A rejection pays the seller's frozen reject split and therefore carries the
 * same owner consent and immutable terms as release. */
export async function requestReject(agent: AgentPrincipal, taskId: string) {
  assertScope(agent, 'request_release');
  return createBoundApproval(agent, taskId, 'REJECT');
}

export async function ownerRequestHire(session: Session, agentId: string, taskId: string) {
  const owner = await ownerForSession(session);
  return requestHire(await ownedAgent(owner.id, agentId, 'request_hire'), taskId);
}

export async function ownerRequestRelease(session: Session, agentId: string, taskId: string) {
  const owner = await ownerForSession(session);
  return requestRelease(await ownedAgent(owner.id, agentId, 'request_release'), taskId);
}

export async function ownerRequestReject(session: Session, agentId: string, taskId: string) {
  const owner = await ownerForSession(session);
  return requestReject(await ownedAgent(owner.id, agentId, 'request_release'), taskId);
}

export async function getTaskForAgent(agent: AgentPrincipal, taskId: string) {
  assertScope(agent, 'get_task');
  const [task] = await db()`
    SELECT t.*, w.display_name AS worker_name, w.wallet_address AS worker_wallet
    FROM tasks t LEFT JOIN workers w ON w.id = t.assigned_worker_id
    WHERE t.id = ${taskId} AND t.agent_id = ${agent.id}
  `;
  assert(task, 404, 'task_not_found', 'Task was not found for this agent.');
  const [evidence] = await db()`
    SELECT id, media_type, byte_length, sha256, report, uploaded_at FROM evidence WHERE task_id = ${taskId}
  `;
  const signedReadUrl = evidence ? await (await import('./evidence')).createEvidenceReadUrl(evidence.id, { agentId: agent.id }) : undefined;
  return { ...publicTask(task), evidence: evidence ? { ...safeEvidence(evidence), signedReadUrl } : null };
}

export async function cancelTask(session: Session, taskId: string) {
  const owner = await ownerForSession(session);
  return db().begin(async (tx) => {
    const [task] = await tx`SELECT id, agent_id, owner_id, state, amount_atomic, asset, network, decimals, legacy_read_only FROM tasks WHERE id = ${taskId} AND owner_id = ${owner.id} FOR UPDATE`;
    assert(task, 404, 'task_not_found', 'Task was not found for this owner.');
    assertTaskWritable(task);
    assert(['OPEN','ASSIGNED'].includes(task.state), 409, 'task_cannot_cancel', 'Only unfunded tasks can be cancelled.');
    await tx`UPDATE approvals SET status = 'DENIED' WHERE task_id = ${taskId} AND status IN ('PENDING','APPROVED')`;
    await tx`UPDATE tasks SET state = 'CANCELLED', assigned_worker_id = NULL WHERE id = ${taskId}`;
    await tx`UPDATE agents SET reserved_atomic = reserved_atomic - ${task.amount_atomic} WHERE id = ${task.agent_id} AND reserved_atomic >= ${task.amount_atomic}`;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, task_id, event_type)
      VALUES ('owner', ${owner.id}, ${taskId}, 'task_cancelled')
    `;
    return { taskId, state: 'CANCELLED' as const };
  });
}

export async function resolveReview(session: Session, taskId: string, decision: 'accept' | 'request_review', note?: string) {
  const owner = await ownerForSession(session);
  return db().begin(async (tx) => {
    const [task] = await tx`SELECT id, state, owner_id, asset, network, decimals, legacy_read_only FROM tasks WHERE id = ${taskId} AND owner_id = ${owner.id} FOR UPDATE`;
    assert(task, 404, 'task_not_found', 'Task was not found for this owner.');
    assertTaskWritable(task);
    assert(task.state === 'REVIEW' || task.state === 'SUBMITTED', 409, 'task_not_in_review', 'Task is not awaiting review.');
    const [release] = await tx`
      SELECT id FROM approvals
      WHERE task_id = ${taskId} AND kind = 'RELEASE' AND status = 'ISSUED'
      FOR UPDATE
    `;
    assert(!release, 409, 'release_already_issued', 'The accepted review is frozen because release transaction bytes have already been issued.');
    const state = decision === 'accept' ? 'SUBMITTED' : 'REVIEW';
    const stored = decision === 'accept' ? 'ACCEPT' : 'REQUEST_REVIEW';
    await tx`UPDATE tasks SET state = ${state}, review_decision = ${stored}, review_note = ${note ?? null} WHERE id = ${taskId}`;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail)
      VALUES ('owner', ${owner.id}, ${taskId}, 'review_resolved', ${tx.json({ decision: stored })})
    `;
    return { taskId, state, decision: stored };
  });
}

export async function createBoundApproval(agent: AgentPrincipal, taskId: string, kind: 'HIRE' | 'RELEASE' | 'REJECT') {
  return db().begin(async (tx) => {
    const [task] = await tx`
      SELECT id, owner_id, agent_id, state, amount_atomic, asset, network, decimals, review_window_ms, reject_split_bps, deadline, review_decision, assigned_worker_id
      FROM tasks WHERE id = ${taskId} AND agent_id = ${agent.id} FOR UPDATE
    `;
    assert(task, 404, 'task_not_found', 'Task was not found for this agent.');
    assertTaskWritable(task);
    if (kind === 'HIRE') {
      assert(task.state === 'ASSIGNED' || task.state === 'FUNDING', 409, 'task_not_assigned', 'A worker must accept this open task before hire confirmation.');
      if (task.state === 'ASSIGNED') {
        assert(new Date(task.deadline).getTime() > Date.now(), 409, 'task_expired', 'Task deadline has passed.');
      }
    } else if (kind === 'RELEASE') {
      assert(task.state === 'SUBMITTED' && task.review_decision === 'ACCEPT', 409, 'review_required', 'An accepted submission is required before release.');
    } else {
      assert((task.state === 'REVIEW' || task.state === 'SUBMITTED') && task.review_decision === 'REQUEST_REVIEW', 409, 'review_required', 'A submission requesting review is required before rejection.');
    }
    const [worker] = await tx`SELECT id, status, wallet_address FROM workers WHERE id = ${task.assigned_worker_id} FOR UPDATE`;
    const [owner] = await tx`SELECT id, wallet_address FROM owners WHERE id = ${task.owner_id} FOR UPDATE`;
    assert(worker?.status === 'VERIFIED' && worker.wallet_address, 409, 'worker_wallet_required', 'The assigned worker needs a verified wallet and human proof.');
    assert(owner?.wallet_address, 409, 'owner_wallet_required', 'Link a signed owner funding wallet first.');

    await tx`
      UPDATE approvals SET status = 'EXPIRED'
      WHERE task_id = ${taskId} AND kind = ${kind} AND status IN ('PENDING','APPROVED') AND expires_at <= now()
    `;
    const [active] = await tx`
      SELECT id, status, amount_atomic, asset, network, decimals, review_window_ms, reject_split_bps, fee_quote_bps, fee_quote_atomic, net_quote_atomic, worker_id, worker_wallet, owner_wallet, expires_at, transaction_bytes_base64, expected_digest
      FROM approvals WHERE task_id = ${taskId} AND kind = ${kind} AND status IN ('PENDING','APPROVED','ISSUED')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (active) {
      assert(active.worker_id === worker.id && active.worker_wallet === worker.wallet_address && active.owner_wallet === owner.wallet_address && String(active.amount_atomic) === String(task.amount_atomic),
        409, 'approval_snapshot_changed', 'The task, amount, or linked wallet changed; start a new approval.');
      if (task.state === 'FUNDING') {
        assert(active.status === 'ISSUED' && active.transaction_bytes_base64 && active.expected_digest,
          409, 'funding_attempt_in_progress', 'A funding attempt is already in progress; resume its frozen transaction instead of requesting another approval.');
      }
      if (kind === 'HIRE' && active.status !== 'ISSUED') {
        const liveFeeQuoteBps = await currentT2000FeeQuoteBps();
        if (active.fee_quote_bps == null || Number(active.fee_quote_bps) !== liveFeeQuoteBps) {
          // PENDING/APPROVED approvals have no frozen chain bytes. Expire the
          // stale snapshot so this call can issue a fresh quote and consent;
          // an ISSUED approval remains the sole resumable funding attempt.
          await tx`
            UPDATE approvals SET status = 'EXPIRED'
            WHERE id = ${active.id} AND status IN ('PENDING', 'APPROVED')
          `;
        } else {
          return approvalResult(active);
        }
      } else {
        return approvalResult(active);
      }
    }
    assert(task.state !== 'FUNDING', 409, 'funding_attempt_unrecoverable', 'Funding is already in progress but its frozen transaction approval is unavailable; reconcile the original attempt before continuing.');
    const feeQuoteBps = await currentT2000FeeQuoteBps();
    const id = uuid();
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    await tx`
      INSERT INTO approvals (id, task_id, owner_id, agent_id, kind, status, amount_atomic, asset, network, decimals, review_window_ms, reject_split_bps, fee_quote_bps, fee_quote_atomic, net_quote_atomic, worker_id, worker_wallet, owner_wallet, expires_at)
      VALUES (${id}, ${taskId}, ${task.owner_id}, ${agent.id}, ${kind}, 'PENDING', ${task.amount_atomic}, ${task.asset}, ${task.network}, ${task.decimals}, ${task.review_window_ms}, ${task.reject_split_bps}, ${feeQuoteBps}, (${task.amount_atomic}::bigint * ${feeQuoteBps} / 10000), (${task.amount_atomic}::bigint - (${task.amount_atomic}::bigint * ${feeQuoteBps} / 10000)), ${worker.id}, ${worker.wallet_address}, ${owner.wallet_address}, ${expiresAt})
    `;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail)
      VALUES ('agent', ${agent.id}, ${taskId}, 'owner_approval_requested', ${tx.json({ kind, amountAtomic: String(task.amount_atomic), asset: task.asset, network: task.network, decimals: Number(task.decimals), reviewWindowMs: Number(task.review_window_ms), rejectSplitBps: Number(task.reject_split_bps), feeQuoteBps })})
    `;
    return { approvalId: id, kind, status: 'PENDING', amountAtomic: String(task.amount_atomic), asset: task.asset, network: task.network, decimals: Number(task.decimals), reviewWindowMs: Number(task.review_window_ms), rejectSplitBps: Number(task.reject_split_bps), feeQuoteBps, feeQuoteAtomic: String((BigInt(task.amount_atomic) * BigInt(feeQuoteBps)) / 10_000n), netQuoteAtomic: String(BigInt(task.amount_atomic) - (BigInt(task.amount_atomic) * BigInt(feeQuoteBps)) / 10_000n), workerWallet: worker.wallet_address, ownerWallet: owner.wallet_address, expiresAt: expiresAt.toISOString() };
  });
}

export async function ownedAgent(ownerId: string, agentId: string, scope: AgentToolName): Promise<AgentPrincipal> {
  const [agent] = await db()`
    SELECT id, owner_id, name, scopes, categories, max_task_atomic, total_budget_atomic
    FROM agents WHERE id = ${agentId} AND owner_id = ${ownerId} AND active = true
  `;
  assert(agent, 404, 'agent_not_found', 'Agent was not found for this owner.');
  const principal: AgentPrincipal = {
    id: agent.id,
    ownerId: agent.owner_id,
    name: agent.name,
    scopes: agent.scopes,
    categories: agent.categories,
    maxTaskAtomic: String(agent.max_task_atomic),
    totalBudgetAtomic: String(agent.total_budget_atomic),
  };
  assertScope(principal, scope);
  return principal;
}

export function assertScope(agent: AgentPrincipal, scope: AgentToolName): void {
  assert(agent.scopes.includes(scope), 403, 'agent_scope_rejected', 'This agent does not have permission for that tool.');
}

export function publicTask(row: Record<string, any>, options: { includePrivate?: boolean } = {}) {
  const task = {
    id: row.id,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    title: row.title,
    category: row.category,
    area: row.area,
    amountAtomic: String(row.amount_atomic),
    asset: row.asset ?? 'USDC',
    network: row.network ?? 'mainnet',
    decimals: Number(row.decimals ?? 6),
    reviewWindowMs: Number(row.review_window_ms ?? DEFAULT_REVIEW_WINDOW_MS),
    rejectSplitBps: Number(row.reject_split_bps ?? DEFAULT_REJECT_SPLIT_BPS),
    deadline: new Date(row.deadline).toISOString(),
    state: row.state,
    worker: row.assigned_worker_id ? {
      id: row.assigned_worker_id,
      displayName: row.worker_name ?? null,
      walletAddress: row.worker_wallet ?? null,
    } : null,
    jobId: row.job_id ?? null,
    fundingDigest: row.funding_digest ?? null,
    submissionDigest: row.submission_digest ?? null,
    releaseDigest: row.release_digest ?? null,
    refundDigest: row.refund_digest ?? null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    reviewDecision: row.review_decision ?? null,
    reviewNote: row.review_note ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (options.includePrivate !== false) {
    return { ...task, brief: row.brief, rubric: row.rubric };
  }
  return task;
}

export function safeEvidence(row: Record<string, any>) {
  return {
    id: row.id,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    report: row.report,
    uploadedAt: new Date(row.uploaded_at).toISOString(),
  };
}

function approvalResult(row: Record<string, any>) {
  return {
    approvalId: row.id,
    kind: row.kind,
    status: row.status,
    amountAtomic: String(row.amount_atomic),
    asset: row.asset ?? 'USDC',
    network: row.network ?? 'mainnet',
    decimals: Number(row.decimals ?? 6),
    reviewWindowMs: Number(row.review_window_ms ?? DEFAULT_REVIEW_WINDOW_MS),
    rejectSplitBps: Number(row.reject_split_bps ?? DEFAULT_REJECT_SPLIT_BPS),
    feeQuoteBps: row.fee_quote_bps == null ? T2000_FEE_QUOTE_BPS : Number(row.fee_quote_bps),
    feeQuoteAtomic: row.fee_quote_atomic == null ? null : String(row.fee_quote_atomic),
    netQuoteAtomic: row.net_quote_atomic == null ? null : String(row.net_quote_atomic),
    workerWallet: row.worker_wallet,
    ownerWallet: row.owner_wallet,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function isCheckViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23514';
}
