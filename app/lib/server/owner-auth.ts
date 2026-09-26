import type postgres from 'postgres';
import { beginWorldAgentsAuthorization, completeWorldAgentsAuthorization, type WorldAgentsAuthorizationTransaction } from '../world';
import { db } from './db';
import { assert, HttpError } from './errors';
import { readSession, type Session } from './session';
import { sha256, uuid } from './security';

function worldConfig() {
  const { WORLD_AGENTS_ISSUER, WORLD_AGENTS_CLIENT_ID, WORLD_AGENTS_CLIENT_SECRET, WORLD_AGENTS_REDIRECT_URI } = process.env;
  assert(WORLD_AGENTS_ISSUER && WORLD_AGENTS_CLIENT_ID && WORLD_AGENTS_CLIENT_SECRET && WORLD_AGENTS_REDIRECT_URI,
    503, 'owner_auth_not_configured', 'Owner authentication is not configured.');
  return { issuer: WORLD_AGENTS_ISSUER, clientId: WORLD_AGENTS_CLIENT_ID, clientSecret: WORLD_AGENTS_CLIENT_SECRET, redirectUri: WORLD_AGENTS_REDIRECT_URI };
}

export async function beginOwnerLogin(session: Session) {
  return beginFlow(session, 'owner_login');
}

export async function beginOwnerApproval(session: Session, approvalId: string) {
  assert(session.ownerId, 401, 'owner_required', 'Sign in as an owner before authorizing a task.');
  const [approval] = await db()`
    SELECT id, owner_id, status, kind, expires_at FROM approvals WHERE id = ${approvalId} AND owner_id = ${session.ownerId}
  `;
  assert(approval && approval.status === 'PENDING' && new Date(approval.expires_at).getTime() > Date.now(), 409, 'approval_expired', 'This owner approval is no longer available.');
  return beginFlow(session, 'protected_approval', approvalId);
}

async function beginFlow(session: Session, purpose: 'owner_login' | 'protected_approval', approvalId?: string) {
  let ownerId: string | null = null;
  if (purpose === 'protected_approval') {
    assert(session.ownerId && approvalId, 401, 'owner_required', 'Sign in as an owner before authorizing a task.');
    ownerId = session.ownerId;
  }
  let begun: Awaited<ReturnType<typeof beginWorldAgentsAuthorization>>;
  try {
    begun = await beginWorldAgentsAuthorization({ ...worldConfig(), purpose, maxAgeSeconds: 300 });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'owner_auth_unavailable', 'Owner authentication could not be started.');
  }
  const { transaction } = begun;
  const id = uuid();
  await db()`
    INSERT INTO oidc_flows (
      id, state_hash, nonce, code_verifier, purpose, session_id, owner_id, approval_id,
      issued_at_epoch, transaction_expires_at_epoch, max_age_seconds, expires_at
    ) VALUES (
      ${id}, ${sha256(transaction.state)}, ${transaction.nonce}, ${transaction.codeVerifier}, ${purpose},
      ${session.id}, ${ownerId}, ${approvalId ?? null}, ${transaction.issuedAt},
      ${transaction.expiresAt}, ${transaction.maxAgeSeconds}, ${new Date(transaction.expiresAt * 1000)}
    )
  `;
  return { authorizationUrl: begun.url, expiresAt: new Date(transaction.expiresAt * 1000).toISOString() };
}

export async function handleWorldCallback(request: Request): Promise<Response> {
  const callback = new URL(request.url);
  const stateValues = callback.searchParams.getAll('state');
  const state = stateValues.length === 1 ? stateValues[0] : null;
  if (!state) return callbackRedirect(request, 'failed');

  const session = await readSession(request);
  let flow: Record<string, any> | null | undefined;
  try {
    flow = await consumeFlow(state) as Record<string, any> | null;
  } catch {
    return callbackRedirect(request, 'failed');
  }
  if (!flow || !session || session.id !== flow.session_id) {
    await denyApprovalIfPresent(flow?.approval_id);
    return callbackRedirect(request, 'failed');
  }

  const transaction: WorldAgentsAuthorizationTransaction = {
    purpose: flow.purpose,
    state,
    nonce: flow.nonce,
    codeVerifier: flow.code_verifier,
    issuedAt: Number(flow.issued_at_epoch),
    expiresAt: Number(flow.transaction_expires_at_epoch),
    maxAgeSeconds: flow.max_age_seconds,
  };
  let identity;
  try {
    identity = await completeWorldAgentsAuthorization({ ...worldConfig(), callbackUrl: callback, transaction });
  } catch {
    await denyApprovalIfPresent(flow.approval_id);
    return callbackRedirect(request, 'denied');
  }

  try {
    if (flow.purpose === 'owner_login') {
      await completeOwnerLogin(session, identity.issuer, identity.subject);
      return callbackRedirect(request, 'signed_in');
    }
    await completeBoundApproval(session, flow, identity.issuer, identity.subject);
    return callbackRedirect(request, 'approved');
  } catch {
    await denyApprovalIfPresent(flow.approval_id);
    return callbackRedirect(request, 'failed');
  }
}

async function consumeFlow(state: string) {
  return db().begin(async (tx) => {
    const [flow] = await tx`SELECT * FROM oidc_flows WHERE state_hash = ${sha256(state)} FOR UPDATE`;
    if (!flow || flow.consumed_at || new Date(flow.expires_at).getTime() <= Date.now()) return null;
    await tx`UPDATE oidc_flows SET consumed_at = now() WHERE id = ${flow.id}`;
    return flow;
  });
}

async function completeOwnerLogin(session: Session, issuer: string, subject: string) {
  await db().begin(async (tx) => {
    const [stored] = await tx`
      INSERT INTO owners (id, oidc_issuer, oidc_subject)
      VALUES (${uuid()}, ${issuer}, ${subject})
      ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET updated_at = now()
      RETURNING id
    `;
    const [current] = await tx`SELECT owner_id FROM sessions WHERE id = ${session.id} FOR UPDATE`;
    assert(current && (!current.owner_id || current.owner_id === stored.id), 409, 'session_account_conflict', 'This browser session is linked to another owner account.');
    await tx`UPDATE sessions SET owner_id = ${stored.id} WHERE id = ${session.id}`;
    await tx`INSERT INTO audit_events (actor_type, actor_id, event_type) VALUES ('owner', ${stored.id}, 'owner_signed_in')`;
  });
}

async function completeBoundApproval(session: Session, flow: Record<string, any>, issuer: string, subject: string) {
  assert(session.ownerId === flow.owner_id, 403, 'owner_mismatch', 'This owner session does not match the approval.');
  await db().begin(async (tx) => {
    const [owner] = await tx`SELECT id, oidc_issuer, oidc_subject, wallet_address FROM owners WHERE id = ${flow.owner_id} FOR UPDATE`;
    assert(owner && owner.oidc_issuer === issuer && owner.oidc_subject === subject, 403, 'owner_mismatch', 'This authentication belongs to a different owner.');
    const [approval] = await tx`
      SELECT id, owner_id, agent_id, task_id, kind, status, amount_atomic, worker_id, worker_wallet, owner_wallet, expires_at
      FROM approvals WHERE id = ${flow.approval_id} AND owner_id = ${owner.id} FOR UPDATE
    `;
    assert(approval && approval.status === 'PENDING' && new Date(approval.expires_at).getTime() > Date.now(), 409, 'approval_expired', 'This owner approval is no longer available.');
    assert(owner.wallet_address === approval.owner_wallet, 409, 'approval_snapshot_changed', 'The funding wallet changed; request fresh approval.');
    const [task] = await tx`
      SELECT state, amount_atomic, deadline, review_decision, assigned_worker_id, agent_id
      FROM tasks WHERE id = ${approval.task_id} AND owner_id = ${owner.id} FOR UPDATE
    `;
    assert(task && task.amount_atomic === approval.amount_atomic && task.assigned_worker_id === approval.worker_id, 409, 'approval_snapshot_changed', 'The task, amount, or worker changed; request fresh approval.');
    assert(task.agent_id === approval.agent_id, 409, 'approval_snapshot_changed', 'Task ownership changed; request fresh approval.');
    if (approval.kind === 'HIRE') {
      assert(task.state === 'ASSIGNED' || task.state === 'FUNDING', 409, 'task_unavailable', 'The accepted task expired or changed before approval.');
      assert(task.state !== 'FUNDING', 409, 'funding_attempt_in_progress', 'A funding transaction is already in progress; resume its frozen bytes instead of authorizing another attempt.');
      assert(new Date(task.deadline).getTime() > Date.now(), 409, 'task_unavailable', 'The accepted task expired or changed before approval.');
    } else if (approval.kind === 'RELEASE') {
      assert(task.state === 'SUBMITTED' && task.review_decision === 'ACCEPT', 409, 'review_required', 'The accepted review changed before approval.');
    } else {
      assert((task.state === 'REVIEW' || task.state === 'SUBMITTED') && task.review_decision === 'REQUEST_REVIEW', 409, 'review_required', 'The review decision changed before rejection approval.');
    }
    const [worker] = await tx`SELECT status, wallet_address FROM workers WHERE id = ${approval.worker_id} FOR UPDATE`;
    assert(worker?.status === 'VERIFIED' && worker.wallet_address === approval.worker_wallet, 409, 'approval_snapshot_changed', 'The worker wallet changed; request fresh approval.');
    await tx`UPDATE approvals SET status = 'APPROVED', consented_at = now() WHERE id = ${approval.id}`;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail)
      VALUES ('owner', ${owner.id}, ${approval.task_id}, 'owner_approved_action', ${tx.json({ kind: approval.kind, amountAtomic: String(approval.amount_atomic) })})
    `;
  });
}

async function denyApprovalIfPresent(approvalId: string | null | undefined) {
  if (!approvalId) return;
  await db()`
    UPDATE approvals SET status = 'DENIED'
    WHERE id = ${approvalId} AND status = 'PENDING'
  `;
}

function callbackRedirect(request: Request, result: string): Response {
  const base = process.env.APP_URL ? new URL(process.env.APP_URL) : new URL(request.url);
  const destination = new URL('/', base);
  destination.searchParams.set('world_auth', result);
  return new Response(null, {
    status: 303,
    headers: {
      Location: destination.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
