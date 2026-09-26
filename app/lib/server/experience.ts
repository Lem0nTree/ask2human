import { db } from './db';
import { assert } from './errors';
import { ownerForSession, workerForSession } from './identity';
import { isAgentPostingAuthorized } from './profile-authorization';
import { uuid } from './security';
import type { Session } from './session';

const MAINNET_USDC = {
  symbol: 'USDC',
  coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  decimals: 6,
  network: 'mainnet',
} as const;

function feeAtBps(grossAtomic: string, feeBps: number): string {
  return ((BigInt(grossAtomic) * BigInt(feeBps)) / 10_000n).toString();
}

export async function listPublicTasks(filters: { category?: string; query?: string; status?: "open" | "completed" } = {}) {
  const rows = await db()`
    SELECT id, title, category, area, amount_atomic, asset, network, decimals,
           deadline, state, created_at
    FROM tasks
    WHERE (
        (${filters.status === 'completed'} AND state IN ('PAID', 'REJECTED')
          AND EXISTS (SELECT 1 FROM settlements s WHERE s.task_id = tasks.id AND s.settled_at IS NOT NULL))
        OR (${filters.status !== 'completed'} AND state = 'OPEN' AND deadline > now())
      )
      AND (${filters.category ?? null}::text IS NULL OR category = ${filters.category ?? null})
      AND (${filters.query ? `%${filters.query.trim()}%` : null}::text IS NULL OR
           title ILIKE ${filters.query ? `%${filters.query.trim()}%` : null} OR
           category ILIKE ${filters.query ? `%${filters.query.trim()}%` : null} OR
           area ILIKE ${filters.query ? `%${filters.query.trim()}%` : null})
    ORDER BY created_at DESC LIMIT 100
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    area: row.area,
    amountAtomic: String(row.amount_atomic),
    asset: assetFrom(row),
    deadline: asIso(row.deadline),
    state: row.state,
    createdAt: asIso(row.created_at),
  }));
}

export async function getPublicTaskStats(filters: { category?: string; query?: string; status?: "open" | "completed" } = {}) {
  const [row] = await db()`
    SELECT COUNT(*)::integer AS count,
           COALESCE(SUM(CASE WHEN asset = 'USDC' AND network = 'mainnet' THEN amount_atomic::numeric ELSE 0 END), 0) AS total_payout_atomic
    FROM tasks
    WHERE (
        (${filters.status === 'completed'} AND state IN ('PAID', 'REJECTED')
          AND EXISTS (SELECT 1 FROM settlements s WHERE s.task_id = tasks.id AND s.settled_at IS NOT NULL))
        OR (${filters.status !== 'completed'} AND state = 'OPEN' AND deadline > now())
      )
      AND (${filters.category ?? null}::text IS NULL OR category = ${filters.category ?? null})
      AND (${filters.query ? `%${filters.query.trim()}%` : null}::text IS NULL OR
           title ILIKE ${filters.query ? `%${filters.query.trim()}%` : null} OR
           category ILIKE ${filters.query ? `%${filters.query.trim()}%` : null} OR
           area ILIKE ${filters.query ? `%${filters.query.trim()}%` : null})
  `;
  return { count: Number(row.count), totalPayoutAtomic: String(row.total_payout_atomic) };
}

export async function getExperienceTask(taskId: string, session?: Session | null) {
  const [row] = await db()`
    SELECT t.*, w.display_name AS worker_name, w.wallet_address AS worker_wallet,
           w.status AS worker_status, w.idkit_verified_at AS worker_idkit_verified_at,
           w.wallet_verified_at AS worker_wallet_verified_at,
           s.status AS settlement_status, s.amount_atomic AS settlement_amount_atomic,
           s.asset AS settlement_asset, s.network AS settlement_network,
           s.decimals AS settlement_decimals, s.fee_atomic, s.net_atomic,
           s.fee_quote_bps, s.fee_quote_atomic, s.funding_fee_bps,
           s.fee_acknowledged_at, s.score_digest, s.score_ready_at,
           s.job_id AS settlement_job_id, s.settled_at, s.release_digest,
           COALESCE(s.delivered_at, t.delivered_at) AS chain_delivered_at,
           s.rejection_digest AS settlement_rejection_digest,
           e.id AS evidence_id, e.media_type, e.byte_length, e.sha256 AS evidence_sha256,
           e.report AS evidence_report, e.uploaded_at
    FROM tasks t
    LEFT JOIN workers w ON w.id = t.assigned_worker_id
    LEFT JOIN settlements s ON s.task_id = t.id
    LEFT JOIN evidence e ON e.task_id = t.id
    WHERE t.id = ${taskId}
  `;
  assert(row, 404, 'task_not_found', 'Task was not found.');

  const owner = session?.ownerId ? await ownerForSession(session).catch(() => null) : null;
  const worker = session?.workerId ? await workerForSession(session).catch(() => null) : null;
  const isOwner = owner?.id === row.owner_id;
  const isSelectedWorker = worker?.id === row.assigned_worker_id;
  const isParticipant = isOwner || isSelectedWorker;
  const canReadOpenBrief = row.state === 'OPEN' && worker?.status === 'VERIFIED' && !!worker.wallet_address && !!worker.wallet_verified_at;
  const [application] = worker ? await db()`
    SELECT status FROM task_applications WHERE task_id = ${taskId} AND worker_id = ${worker.id}
  ` : [];
  const approvalRows = await db()`
    SELECT kind, status, fee_quote_bps, fee_quote_atomic, net_quote_atomic
    FROM approvals
    WHERE task_id = ${taskId} AND kind IN ('HIRE','RELEASE','REJECT')
      AND status IN ('PENDING','APPROVED','ISSUED')
      AND (status = 'ISSUED' OR expires_at > now())
    ORDER BY created_at DESC, id DESC
  `;
  const latestApprovalByKind = new Map<string, (typeof approvalRows)[number]>();
  for (const approval of approvalRows) if (!latestApprovalByKind.has(approval.kind)) latestApprovalByKind.set(approval.kind, approval);
  const hireApproval = latestApprovalByKind.get('HIRE');
  const auditRows = await db()`
    SELECT event_type, created_at FROM audit_events
    WHERE task_id = ${taskId}
    ORDER BY created_at ASC, id ASC
  `;

  const history = auditRows.map((event) => ({ label: auditLabel(event.event_type), at: asIso(event.created_at), state: event.event_type }));
  if (history.length === 0) history.push({ label: 'Task posted', at: asIso(row.created_at), state: 'task_created' });
  const deliveredAt = row.chain_delivered_at ? asIso(row.chain_delivered_at) : null;
  const reviewEndsAt = deliveredAt
    ? new Date(new Date(deliveredAt).getTime() + Number(row.review_window_ms)).toISOString()
    : null;
  const evidence = isParticipant && row.evidence_id ? {
    id: row.evidence_id,
    mediaType: row.media_type,
    byteLength: Number(row.byte_length),
    sha256: row.evidence_sha256,
    report: row.evidence_report,
    uploadedAt: asIso(row.uploaded_at),
  } : null;
  const [rating] = isOwner && owner?.wallet_address ? await db()`
    SELECT stars, digest, created_at, confirmed_at FROM ratings
    WHERE task_id = ${taskId} AND reviewer_wallet = ${owner.wallet_address}
  ` : [];

  const canApply = !!worker && worker.status === 'VERIFIED' && !!worker.wallet_address && !!worker.wallet_verified_at &&
    row.state === 'OPEN' && new Date(row.deadline).getTime() > Date.now() && worker.category === row.category;
  const settlement = row.settlement_status ? (() => {
    const grossAtomic = String(row.settlement_amount_atomic ?? row.amount_atomic);
    const feeQuoteBps = row.fee_quote_bps == null ? null : Number(row.fee_quote_bps);
    const fundingFeeBps = row.funding_fee_bps == null ? null : Number(row.funding_fee_bps);
    const feeQuoteAtomic = row.fee_quote_atomic == null
      ? feeQuoteBps == null ? null : feeAtBps(grossAtomic, feeQuoteBps)
      : String(row.fee_quote_atomic);
    const fundingFeeAtomic = fundingFeeBps == null ? null : feeAtBps(grossAtomic, fundingFeeBps);
    return {
      grossAtomic,
      feeAtomic: row.fee_atomic == null ? null : String(row.fee_atomic),
      netAtomic: row.net_atomic == null ? null : String(row.net_atomic),
      feeQuoteBps,
      feeQuoteAtomic,
      netQuoteAtomic: feeQuoteAtomic == null ? null : (BigInt(grossAtomic) - BigInt(feeQuoteAtomic)).toString(),
      fundingFeeBps,
      fundingFeeAtomic,
      fundingNetAtomic: fundingFeeAtomic == null ? null : (BigInt(grossAtomic) - BigInt(fundingFeeAtomic)).toString(),
      feeChanged: feeQuoteBps != null && fundingFeeBps != null && feeQuoteBps !== fundingFeeBps,
      feeAcknowledgedAt: row.fee_acknowledged_at ? asIso(row.fee_acknowledged_at) : null,
      scoreReady: Boolean(row.score_ready_at || row.score_digest),
      jobId: row.settlement_job_id ?? null,
      settledAt: row.settled_at ? asIso(row.settled_at) : null,
      digest: row.release_digest ?? row.settlement_rejection_digest ?? null,
      status: row.settlement_status,
    };
  })() : null;

  return {
    id: row.id,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    title: row.title,
    brief: isParticipant || canReadOpenBrief ? row.brief : null,
    category: row.category,
    area: row.area,
    checklist: isParticipant || canReadOpenBrief ? safeChecklist(row.rubric) : [],
    amountAtomic: String(row.amount_atomic),
    asset: assetFrom(row),
    deadline: asIso(row.deadline),
    state: row.state,
    terms: { reviewWindowMs: Number(row.review_window_ms), rejectSplitBps: Number(row.reject_split_bps) },
    quote: hireApproval ? {
      grossAtomic: String(row.amount_atomic),
      feeAtomic: hireApproval.fee_quote_atomic == null ? null : String(hireApproval.fee_quote_atomic),
      netAtomic: hireApproval.net_quote_atomic == null ? null : String(hireApproval.net_quote_atomic),
      feeBps: hireApproval.fee_quote_bps == null ? null : Number(hireApproval.fee_quote_bps),
    } : null,
    worker: row.assigned_worker_id ? {
      id: row.assigned_worker_id,
      displayName: row.worker_name,
      walletAddress: isParticipant ? row.worker_wallet : null,
      worldVerified: Boolean(row.worker_idkit_verified_at),
      profilePath: `/workers/${row.assigned_worker_id}`,
    } : null,
    settlement,
    deliveredAt,
    rating: rating ? { stars: Number(rating.stars), digest: rating.digest, createdAt: asIso(rating.created_at), confirmedAt: rating.confirmed_at ? asIso(rating.confirmed_at) : null } : null,
    reviewEndsAt,
    reviewDecision: row.review_decision ?? null,
    applicationStatus: application?.status ?? null,
    canApply,
    isOwner,
    isSelectedWorker,
    evidence,
    timeline: history,
    nextAction: taskNextAction(
      row.state,
      isOwner,
      isSelectedWorker,
      canApply,
      application?.status,
      isOwner ? (row.state === 'FUNDING' || row.state === 'ASSIGNED' ? latestApprovalByKind.get('HIRE')?.status : row.review_decision === 'REQUEST_REVIEW' ? latestApprovalByKind.get('REJECT')?.status : latestApprovalByKind.get('RELEASE')?.status) : undefined,
      row.review_decision,
      Boolean(rating?.confirmed_at),
    ),
    legacyReadOnly: Boolean(row.legacy_read_only),
  };
}

export async function getWorkerProfile(workerId: string) {
  const [worker] = await db()`
    SELECT id, display_name, category, area, skills, status, idkit_verified_at
    FROM workers WHERE id = ${workerId} AND status = 'VERIFIED'
  `;
  assert(worker, 404, 'worker_profile_not_found', 'Verified worker profile was not found.');
  const [summary] = await db()`
    SELECT AVG(r.stars)::numeric(4,2) AS average_rating, COUNT(r.task_id)::integer AS review_count
    FROM ratings r JOIN tasks t ON t.id = r.task_id
    WHERE t.assigned_worker_id = ${workerId} AND r.confirmed_at IS NOT NULL
  `;
  const recent = await db()`
    SELECT t.id, t.title, t.category, t.amount_atomic, t.asset, t.network, t.decimals,
           COALESCE(s.settled_at, t.updated_at) AS completed_at
    FROM tasks t JOIN settlements s ON s.task_id = t.id
    WHERE t.assigned_worker_id = ${workerId}
      AND t.state IN ('PAID','REJECTED') AND s.settled_at IS NOT NULL
    ORDER BY s.settled_at DESC LIMIT 8
  `;
  return {
    id: worker.id,
    displayName: worker.display_name,
    category: worker.category,
    area: worker.area,
    skills: worker.skills,
    worldVerified: Boolean(worker.idkit_verified_at),
    averageRating: summary.average_rating == null ? null : Number(summary.average_rating),
    reviewCount: Number(summary.review_count ?? 0),
    ratingSource: Number(summary.review_count ?? 0) > 0 ? 't2000' : null,
    recentTasks: recent.map((task) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      amountAtomic: String(task.amount_atomic),
      completedAt: asIso(task.completed_at),
      asset: assetFrom(task),
    })),
  };
}

export async function getWorkerDashboard(session: Session) {
  const worker = await workerForSession(session);
  const groups = await db()`
    SELECT s.asset, s.network, s.decimals,
      COUNT(*)::integer AS record_count,
      COALESCE(SUM(COALESCE(s.fee_atomic, 0) + COALESCE(s.net_atomic, 0)) FILTER (WHERE s.settled_at IS NOT NULL AND s.status IN ('PAID','REJECTED')), 0)::text AS lifetime_gross,
      COALESCE(SUM(s.fee_atomic) FILTER (WHERE s.settled_at IS NOT NULL AND s.status IN ('PAID','REJECTED')), 0)::text AS lifetime_fee,
      COALESCE(SUM(s.net_atomic) FILTER (WHERE s.settled_at IS NOT NULL AND s.status IN ('PAID','REJECTED')), 0)::text AS lifetime_net,
      COALESCE(SUM(s.net_atomic) FILTER (WHERE s.settled_at >= date_trunc('month', now()) AND s.status IN ('PAID','REJECTED')), 0)::text AS month_net,
      COALESCE(SUM(s.amount_atomic) FILTER (WHERE s.settled_at IS NULL AND t.state IN ('FUNDED','SUBMITTED','REVIEW')), 0)::text AS pending
    FROM settlements s JOIN tasks t ON t.id = s.task_id
    WHERE t.assigned_worker_id = ${worker.id}
    GROUP BY s.asset, s.network, s.decimals
  `;
  const paymentRows = await db()`
    SELECT t.id AS task_id, t.title, t.state,
           CASE WHEN s.settled_at IS NOT NULL AND s.status IN ('PAID','REJECTED')
             THEN COALESCE(s.fee_atomic, 0) + COALESCE(s.net_atomic, 0) ELSE 0 END AS seller_gross_atomic,
           s.asset, s.network, s.decimals,
           s.fee_atomic, s.net_atomic, s.job_id,
           COALESCE(s.release_digest, s.rejection_digest) AS digest, s.settled_at, s.status AS settlement_status
    FROM settlements s JOIN tasks t ON t.id = s.task_id
    WHERE t.assigned_worker_id = ${worker.id}
    ORDER BY COALESCE(s.settled_at, s.updated_at) DESC LIMIT 100
  `;
  const tasks = await db()`
    SELECT t.id, t.title, t.category, t.area, t.amount_atomic, t.asset, t.network, t.decimals,
           t.deadline, t.state, t.assigned_worker_id, a.status AS application_status,
           t.updated_at, t.review_window_ms, t.reject_split_bps
    FROM tasks t
    LEFT JOIN task_applications a ON a.task_id = t.id AND a.worker_id = ${worker.id}
    WHERE t.assigned_worker_id = ${worker.id} OR a.worker_id = ${worker.id}
    ORDER BY CASE WHEN t.assigned_worker_id = ${worker.id} THEN 0 ELSE 1 END, t.updated_at DESC LIMIT 100
  `;
  const usdc = groups.find((group) => group.asset === 'USDC' && group.network === 'mainnet' && Number(group.decimals) === 6);
  const totals = {
    lifetimeGrossAtomic: String(usdc?.lifetime_gross ?? '0'),
    lifetimeFeeAtomic: String(usdc?.lifetime_fee ?? '0'),
    lifetimeNetAtomic: String(usdc?.lifetime_net ?? '0'),
    monthNetAtomic: String(usdc?.month_net ?? '0'),
    pendingAtomic: String(usdc?.pending ?? '0'),
    asset: MAINNET_USDC,
  };
  return {
    workerId: worker.id,
    worker: { displayName: worker.display_name, status: worker.status, category: worker.category },
    totals,
    legacyReadOnly: groups.filter((group) => group.network !== 'mainnet' || group.asset !== 'USDC').map((group) => ({
      asset: assetFrom(group),
      recordCount: Number(group.record_count),
    })),
    payments: paymentRows.map((payment) => ({
      taskId: payment.task_id,
      title: payment.title,
      state: payment.state,
      grossAtomic: String(payment.seller_gross_atomic),
      feeAtomic: payment.fee_atomic == null ? null : String(payment.fee_atomic),
      netAtomic: payment.net_atomic == null ? null : String(payment.net_atomic),
      jobId: payment.job_id,
      digest: payment.digest,
      settledAt: payment.settled_at ? asIso(payment.settled_at) : null,
      settlementStatus: payment.settlement_status,
      asset: assetFrom(payment),
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      area: task.area,
      amountAtomic: String(task.amount_atomic),
      asset: assetFrom(task),
      deadline: asIso(task.deadline),
      state: task.state,
      applicationStatus: task.assigned_worker_id === worker.id ? 'SELECTED' : task.application_status,
      assigned: task.assigned_worker_id === worker.id,
    })),
  };
}

export async function getOwnerExperienceDashboard(session: Session) {
  const owner = await ownerForSession(session);
  const agents = await db()`
    SELECT id, owner_id, name, categories, scopes, max_task_atomic, total_budget_atomic, reserved_atomic,
           spent_atomic, asset, network, decimals, active, authorization_required,
           authorization_policy_hash, authorization_wallet, authorization_signature,
           authorization_message, authorized_at
    FROM agents WHERE owner_id = ${owner.id} ORDER BY created_at ASC
  `;
  const taskRows = await db()`
    SELECT t.id, t.agent_id, t.title, t.category, t.area, t.amount_atomic, t.asset,
           t.network, t.decimals, t.deadline, t.state, t.assigned_worker_id,
           w.display_name AS worker_name, t.updated_at
    FROM tasks t LEFT JOIN workers w ON w.id = t.assigned_worker_id
    WHERE t.owner_id = ${owner.id}
    ORDER BY t.updated_at DESC LIMIT 100
  `;
  return {
    owner: { id: owner.id, walletAddress: owner.wallet_address, walletVerified: Boolean(owner.wallet_verified_at) },
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      categories: agent.categories,
      maxTaskAtomic: String(agent.max_task_atomic),
      totalBudgetAtomic: String(agent.total_budget_atomic),
      reservedAtomic: String(agent.reserved_atomic),
      spentAtomic: String(agent.spent_atomic),
      availableAtomic: String(BigInt(agent.total_budget_atomic) - BigInt(agent.reserved_atomic) - BigInt(agent.spent_atomic)),
      asset: assetFrom(agent),
      active: Boolean(agent.active),
      authorizationRequired: !isAgentPostingAuthorized(agent, owner.wallet_address ?? ''),
    })),
    tasks: taskRows.map((task) => ({
      id: task.id,
      agentId: task.agent_id,
      title: task.title,
      category: task.category,
      area: task.area,
      amountAtomic: String(task.amount_atomic),
      asset: assetFrom(task),
      deadline: asIso(task.deadline),
      state: task.state,
      worker: task.assigned_worker_id ? { id: task.assigned_worker_id, displayName: task.worker_name } : null,
    })),
  };
}

export async function getTaskApplicantsForOwner(session: Session, taskId: string) {
  return ownerListApplicants(session, taskId);
}

export type ExperienceAgent = {
  id: string;
  ownerId: string;
  categories?: string[];
};

export type ApplicationNote = string | undefined;

export async function applyForTask(session: Session, taskId: string, note?: ApplicationNote) {
  const worker = await workerForSession(session);
  assert(worker.status === 'VERIFIED' && worker.wallet_address && worker.wallet_verified_at,
    403, 'worker_not_ready', 'Verify your worker profile and link a payout wallet before applying.');
  const normalizedNote = note?.trim() || null;
  assert(!normalizedNote || normalizedNote.length <= 500, 400, 'application_note_invalid', 'Application notes must be 500 characters or fewer.');

  return db().begin(async (tx) => {
    const [task] = await tx`
      SELECT id, category, state, deadline FROM tasks WHERE id = ${taskId} FOR UPDATE
    `;
    assert(task && task.state === 'OPEN' && new Date(task.deadline).getTime() > Date.now(),
      409, 'task_unavailable', 'This task is no longer accepting applications.');
    assert(worker.category === task.category, 403, 'worker_category_mismatch', 'Your verified worker category does not match this task.');

    const applicationId = uuid();
    const inserted = await tx`
      INSERT INTO task_applications (id, task_id, worker_id, note)
      VALUES (${applicationId}, ${taskId}, ${worker.id}, ${normalizedNote})
      ON CONFLICT (task_id, worker_id) DO NOTHING
      RETURNING id, status, created_at
    `;
    const [application] = inserted.length > 0 ? inserted : await tx`
      SELECT id, status, created_at FROM task_applications WHERE task_id = ${taskId} AND worker_id = ${worker.id}
    `;
    assert(application, 500, 'application_unavailable', 'Application status could not be loaded.');
    if (inserted.length > 0) {
      await tx`
        INSERT INTO audit_events (actor_type, actor_id, task_id, event_type)
        VALUES ('worker', ${worker.id}, ${taskId}, 'task_application_created')
      `;
    }
    return {
      taskId,
      applicationId: application.id,
      status: application.status,
      createdAt: new Date(application.created_at).toISOString(),
      alreadyApplied: inserted.length === 0,
    };
  });
}

export async function agentListApplicants(agent: ExperienceAgent, taskId: string) {
  const [task] = await db()`
    SELECT id FROM tasks WHERE id = ${taskId} AND agent_id = ${agent.id}
  `;
  assert(task, 404, 'task_not_found', 'Task was not found for this agent.');
  return listTaskApplicants(taskId);
}

export async function ownerListApplicants(session: Session, taskId: string) {
  const owner = await ownerForSession(session);
  const [task] = await db()`
    SELECT id FROM tasks WHERE id = ${taskId} AND owner_id = ${owner.id}
  `;
  assert(task, 404, 'task_not_found', 'Task was not found for this owner.');
  return listTaskApplicants(taskId);
}

export async function agentSelectWorker(agent: ExperienceAgent, taskId: string, workerId: string) {
  return selectTaskApplicant({ agentId: agent.id, ownerId: agent.ownerId, taskId, workerId, actorType: 'agent', actorId: agent.id, categories: agent.categories });
}

export async function ownerSelectWorker(session: Session, taskId: string, workerId: string) {
  const owner = await ownerForSession(session);
  return selectTaskApplicant({ ownerId: owner.id, taskId, workerId, actorType: 'owner', actorId: owner.id });
}

async function listTaskApplicants(taskId: string) {
  const [task] = await db()`
    SELECT id, state, assigned_worker_id FROM tasks WHERE id = ${taskId}
  `;
  assert(task, 404, 'task_not_found', 'Task was not found.');
  const rows = await db()`
    SELECT a.id, a.worker_id, a.note, a.status, a.created_at,
           w.display_name, w.category, w.area, w.skills, w.status AS worker_status,
           w.idkit_verified_at IS NOT NULL AS world_verified
    FROM task_applications a
    JOIN workers w ON w.id = a.worker_id
    WHERE a.task_id = ${taskId}
    ORDER BY CASE a.status WHEN 'SELECTED' THEN 0 WHEN 'APPLIED' THEN 1 ELSE 2 END, a.created_at ASC
  `;
  return {
    taskId,
    taskState: task.state,
    selectedWorkerId: task.assigned_worker_id,
    applicants: rows.map((row) => ({
      applicationId: row.id,
      workerId: row.worker_id,
      note: row.note,
      status: row.status,
      appliedAt: new Date(row.created_at).toISOString(),
      worker: {
        id: row.worker_id,
        displayName: row.display_name,
        category: row.category,
        area: row.area,
        skills: row.skills,
        worldVerified: Boolean(row.world_verified),
        eligible: row.worker_status === 'VERIFIED',
        profilePath: `/workers/${row.worker_id}`,
      },
    })),
  };
}

function assetFrom(row: Record<string, any>) {
  const asset = row.asset ?? 'SUI';
  const network = row.network ?? 'testnet';
  const decimals = Number(row.decimals ?? (asset === 'USDC' ? 6 : 9));
  const coinType = row.coin_type ?? (asset === 'USDC' ? MAINNET_USDC.coinType : '0x2::sui::SUI');
  return { symbol: asset, coinType, decimals, network };
}

function safeChecklist(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      return safeChecklist(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function auditLabel(eventType: string): string {
  const labels: Record<string, string> = {
    task_created: 'Task posted',
    task_worker_selected: 'Worker selected',
    owner_approval_requested: 'Owner approval requested',
    owner_approved_action: 'Owner approved exact terms',
    funding_transaction_issued: 'Funding transaction prepared',
    funding_confirmed: 'Mainnet escrow funding confirmed',
    submission_confirmed: 'Delivery commitment confirmed on Sui mainnet',
    submission_reviewed: 'Submission reviewed',
    review_resolved: 'Review updated',
    released: 'Payment confirmed',
    rejected: 'Rejection settlement confirmed',
    refunded: 'Refund confirmed',
    timeout_claimed: 'Worker claim confirmed',
    rating_confirmed: 'Public rating recorded',
  };
  return labels[eventType] ?? eventType.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function taskNextAction(
  state: string,
  isOwner: boolean,
  isWorker: boolean,
  canApply: boolean,
  applicationStatus?: string,
  approvalStatus?: string,
  reviewDecision?: string | null,
  hasConfirmedRating = false,
) {
  if (state === 'OPEN') {
    if (canApply && !applicationStatus) return 'Apply for this task';
    if (applicationStatus === 'APPLIED') return 'Application sent; wait for worker selection';
    if (applicationStatus === 'SELECTED') return 'You were selected; owner approval is next';
    if (isOwner) return 'Review applicants or cancel this open task';
    return 'Sign in with a verified, wallet-linked worker profile to apply';
  }
  if (state === 'ASSIGNED') return isOwner
    ? approvalStatus === 'PENDING' ? 'Complete World approval for the exact funding terms'
      : ['APPROVED', 'ISSUED'].includes(approvalStatus ?? '') ? 'Connect the linked owner wallet and sign the frozen funding transaction'
      : 'Approve the selected worker and exact funding terms'
    : isWorker ? 'Wait for the owner to approve and fund escrow' : 'Worker selection is complete';
  if (state === 'FUNDING') return isOwner
    ? approvalStatus === 'PENDING' ? 'Complete World approval for the exact funding terms' : ['APPROVED', 'ISSUED'].includes(approvalStatus ?? '') ? 'Connect the linked owner wallet and sign the frozen funding transaction' : 'Review the task terms and request owner funding approval'
    : isWorker ? 'Wait for funding confirmation' : 'Funding is being confirmed';
  if (state === 'FUNDED') return isWorker ? 'Deliver the work with a report and evidence image' : isOwner ? 'Wait for the selected worker to submit' : 'Work is in progress';
  if (state === 'SUBMITTED' || state === 'REVIEW') {
    if (isOwner && reviewDecision === 'REQUEST_REVIEW') return approvalStatus === 'PENDING'
      ? 'Complete World approval for the exact rejection split'
      : ['APPROVED', 'ISSUED'].includes(approvalStatus ?? '') ? 'Connect the linked owner wallet and sign the frozen rejection transaction' : 'Continue off-chain review or request approval for the rejection split';
    if (isOwner && reviewDecision === 'ACCEPT') return approvalStatus === 'PENDING'
      ? 'Complete World approval for the exact worker payout'
      : ['APPROVED', 'ISSUED'].includes(approvalStatus ?? '') ? 'Connect the linked owner wallet and sign the frozen release transaction' : 'Request owner approval for the worker payout';
    return isOwner ? 'Review delivery and choose the supported settlement action' : isWorker ? 'Wait for the owner review or review-window claim' : 'Delivery is under review';
  }
  if (state === 'PAID') return isOwner ? hasConfirmedRating ? 'Payment and public rating are confirmed' : 'Leave a public task rating' : isWorker ? 'Payment is confirmed in your earnings' : 'Payment is complete';
  if (state === 'REJECTED') return isOwner ? hasConfirmedRating ? 'Rejection settlement and public rating are confirmed' : 'Leave a public task rating' : isWorker ? 'Review the confirmed partial payout in earnings' : 'The rejection settlement is complete';
  if (state === 'REFUNDED') return 'Task funds were returned to the owner';
  if (state === 'CANCELLED') return 'This task was cancelled before funding';
  return 'Refresh the task to see the latest status';
}

async function selectTaskApplicant(input: {
  agentId?: string;
  ownerId: string;
  taskId: string;
  workerId: string;
  actorType: 'agent' | 'owner';
  actorId: string;
  categories?: string[];
}) {
  return db().begin(async (tx) => {
    const [task] = await tx`
      SELECT t.id, t.owner_id, t.agent_id, t.category, t.state, t.deadline, t.assigned_worker_id,
             a.active AS agent_active, a.categories AS agent_categories
      FROM tasks t JOIN agents a ON a.id = t.agent_id
      WHERE t.id = ${input.taskId}
        AND t.owner_id = ${input.ownerId}
        AND (${input.agentId ?? null}::uuid IS NULL OR t.agent_id = ${input.agentId ?? null})
      FOR UPDATE OF t, a
    `;
    assert(task, 404, 'task_not_found', 'Task was not found for this owner agent.');

    const [priorApplication] = await tx`
      SELECT id, status FROM task_applications WHERE task_id = ${input.taskId} AND worker_id = ${input.workerId} FOR UPDATE
    `;
    if (task.assigned_worker_id === input.workerId && priorApplication?.status === 'SELECTED') {
      return { taskId: input.taskId, workerId: input.workerId, state: task.state, status: 'SELECTED', alreadySelected: true };
    }
    assert(task.state === 'OPEN' && !task.assigned_worker_id && new Date(task.deadline).getTime() > Date.now(),
      409, 'task_selection_locked', 'Worker selection is closed because the task is assigned, funded, or past deadline.');
    assert(task.agent_active, 409, 'agent_inactive', 'The task agent is no longer active.');
    assert(task.agent_categories.includes(task.category), 409, 'agent_policy_changed', 'The agent is no longer authorized for this task category.');
    if (input.categories) {
      assert(input.categories.includes(task.category), 403, 'agent_policy_rejected', 'This agent cannot select a worker for the task category.');
    }

    const [attempt] = await tx`
      SELECT task_id FROM settlements WHERE task_id = ${input.taskId} FOR UPDATE
    `;
    const [approval] = await tx`
      SELECT id FROM approvals WHERE task_id = ${input.taskId} AND kind = 'HIRE' FOR UPDATE
    `;
    assert(!attempt && !approval, 409, 'task_selection_locked', 'Worker selection cannot change after a funding attempt or approval exists.');

    const [application] = await tx`
      SELECT a.id, a.status, w.status AS worker_status, w.category,
             w.wallet_address, w.wallet_verified_at, w.idkit_verified_at
      FROM task_applications a JOIN workers w ON w.id = a.worker_id
      WHERE a.task_id = ${input.taskId} AND a.worker_id = ${input.workerId}
      FOR UPDATE OF a, w
    `;
    assert(application?.status === 'APPLIED', 409, 'application_unavailable', 'Choose a worker who has an active application for this task.');
    assert(application.worker_status === 'VERIFIED' && application.idkit_verified_at && application.wallet_address && application.wallet_verified_at,
      409, 'worker_not_ready', 'The selected worker must have verified World identity and a linked payout wallet.');
    assert(application.category === task.category, 409, 'worker_category_mismatch', 'The selected worker category no longer matches the task.');

    const [assigned] = await tx`
      UPDATE tasks SET assigned_worker_id = ${input.workerId}, state = 'ASSIGNED'
      WHERE id = ${input.taskId} AND state = 'OPEN' AND assigned_worker_id IS NULL AND deadline > now()
      RETURNING id
    `;
    assert(assigned, 409, 'task_selection_race', 'Another selection changed this task. Refresh applicants and try again.');
    await tx`
      UPDATE task_applications SET status = CASE WHEN worker_id = ${input.workerId} THEN 'SELECTED' ELSE 'DECLINED' END
      WHERE task_id = ${input.taskId} AND status = 'APPLIED'
    `;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail)
      VALUES (${input.actorType}, ${input.actorId}, ${input.taskId}, 'task_worker_selected', ${tx.json({ workerId: input.workerId })})
    `;
    return { taskId: input.taskId, workerId: input.workerId, state: 'ASSIGNED', status: 'SELECTED', alreadySelected: false };
  });
}
