import type postgres from 'postgres';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { WorldIdKitEnvironment } from '../world';
import { WorldIntegrationError } from '../world';
import { db } from './db';
import { assert, HttpError } from './errors';
import { publicAppOrigin, randomToken, sha256, uuid } from './security';
import type { Session } from './session';
import { createWorkerIdKitRequest, verifyWorkerIdKitResult } from '../world';

type WalletPurpose = 'worker' | 'owner' | 'recover_worker' | 'recover_owner';

export async function createWorkerProfile(session: Session, input: {
  displayName: string;
  category: string;
  area: string;
  skills: string[];
}) {
  assert(!session.workerId, 409, 'worker_exists', 'This session already has a worker profile.');
  const workerId = uuid();
  await db().begin(async (tx) => {
    const [existing] = await tx`SELECT worker_id FROM sessions WHERE id = ${session.id} FOR UPDATE`;
    assert(existing && !existing.worker_id, 409, 'worker_exists', 'This session already has a worker profile.');
    await tx`
      INSERT INTO workers (id, display_name, category, area, skills)
      VALUES (${workerId}, ${input.displayName}, ${input.category}, ${input.area}, ${tx.array(input.skills)})
    `;
    await tx`UPDATE sessions SET worker_id = ${workerId} WHERE id = ${session.id}`;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, event_type)
      VALUES ('worker', ${workerId}, 'worker_registered')
    `;
  });
  return { workerId, status: 'PENDING' as const };
}

export async function startWalletChallenge(session: Session, purpose: WalletPurpose, address: string) {
  const worker = purpose === 'worker' ? await workerForSession(session) : null;
  const owner = purpose === 'owner' ? await ownerForSession(session) : null;
  const canonicalAddress = address.toLowerCase();
  const challengeId = uuid();
  const nonce = randomToken(24);
  const identity = worker ? `worker:${worker.id}` : owner ? `owner:${owner.id}` : `recovery:${session.id}:${purpose}`;
  const origin = publicAppOrigin();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const challengeText = [
    'ask2human Sui wallet verification',
    `Domain: ${new URL(origin).host}`,
    `Account: ${identity}`,
    `Wallet: ${canonicalAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    'Purpose: link or recover a marketplace wallet',
  ].join('\n');

  await db()`
    INSERT INTO wallet_challenges (id, session_id, purpose, address, challenge_text, expires_at)
    VALUES (${challengeId}, ${session.id}, ${purpose}, ${canonicalAddress}, ${challengeText}, ${expiresAt})
  `;
  return { challengeId, message: challengeText, expiresAt: expiresAt.toISOString() };
}

export async function completeWalletChallenge(session: Session, challengeId: string, signature: string) {
  const [candidate] = await db()`
    SELECT address, challenge_text, expires_at, consumed_at
    FROM wallet_challenges WHERE id = ${challengeId} AND session_id = ${session.id}
  `;
  assert(candidate, 404, 'wallet_challenge_missing', 'Wallet challenge was not found.');
  assert(!candidate.consumed_at && new Date(candidate.expires_at).getTime() > Date.now(), 409, 'wallet_challenge_expired', 'Wallet challenge has expired or was already used.');
  try {
    // Slush social-login wallets use zkLogin, whose proof verification requires
    // a network client in Sui SDK 2.x. Address binding also accepts legacy forms.
    await verifyPersonalMessageSignature(new TextEncoder().encode(candidate.challenge_text), signature, {
      address: candidate.address,
      client: new SuiGrpcClient({ network: 'mainnet', baseUrl: process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443' }),
    });
  } catch {
    throw new HttpError(400, 'wallet_signature_invalid', 'The wallet signature does not match this challenge.');
  }

  try {
    return await db().begin(async (tx) => {
      const [challenge] = await tx`
        SELECT * FROM wallet_challenges
        WHERE id = ${challengeId} AND session_id = ${session.id}
        FOR UPDATE
      `;
      assert(challenge, 404, 'wallet_challenge_missing', 'Wallet challenge was not found.');
      assert(!challenge.consumed_at && new Date(challenge.expires_at).getTime() > Date.now(), 409, 'wallet_challenge_expired', 'Wallet challenge has expired or was already used.');
      await tx`UPDATE wallet_challenges SET consumed_at = now() WHERE id = ${challengeId}`;

      if (challenge.purpose === 'worker') {
        assert(session.workerId, 401, 'worker_required', 'Create a worker profile first.');
        await bindWorkerWallet(tx, session.workerId, challenge.address);
        return { purpose: 'worker', address: challenge.address };
      }
      if (challenge.purpose === 'owner') {
        assert(session.ownerId, 401, 'owner_required', 'Sign in as an owner first.');
        await bindOwnerWallet(tx, session.ownerId, challenge.address);
        return { purpose: 'owner', address: challenge.address };
      }
      if (challenge.purpose === 'recover_worker') {
        const [worker] = await tx`SELECT id, status FROM workers WHERE wallet_address = ${challenge.address} FOR UPDATE`;
        assert(worker && worker.status === 'VERIFIED', 404, 'worker_recovery_not_found', 'No verified worker account is linked to this wallet.');
        await attachRecoveredAccount(tx, session.id, 'worker_id', worker.id, session.workerId);
        return { purpose: 'recover_worker', address: challenge.address, workerId: worker.id };
      }
      const [owner] = await tx`SELECT id FROM owners WHERE wallet_address = ${challenge.address} FOR UPDATE`;
      assert(owner, 404, 'owner_recovery_not_found', 'No owner account is linked to this wallet.');
      await attachRecoveredAccount(tx, session.id, 'owner_id', owner.id, session.ownerId);
      return { purpose: 'recover_owner', address: challenge.address, ownerId: owner.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'wallet_already_linked', 'This wallet is already linked to another account.');
    throw error;
  }
}

export async function startWorkerVerification(session: Session) {
  const worker = await workerForSession(session);
  assert(worker.status === 'PENDING', 409, 'worker_already_verified', 'This worker is already verified.');
  assert(worker.wallet_address, 409, 'worker_wallet_required', 'Link a Sui payout wallet before verifying this worker.');
  const { WORLD_ID_APP_ID, WORLD_ID_RP_ID, WORLD_ID_RP_SIGNING_KEY, WORLD_ID_WORKER_ACTION, WORLD_ID_ENVIRONMENT } = process.env;
  assert(WORLD_ID_APP_ID && WORLD_ID_RP_ID && WORLD_ID_RP_SIGNING_KEY && WORLD_ID_WORKER_ACTION && WORLD_ID_ENVIRONMENT,
    503, 'world_id_not_configured', 'Worker verification is not configured.');
  assert(WORLD_ID_ENVIRONMENT === 'production' || process.env.WORLD_ID_STAGING_VERIFICATION_TOKEN,
    503, 'world_id_not_configured', 'Worker verification is awaiting the configured World test window.');

  let request: Awaited<ReturnType<typeof createWorkerIdKitRequest>>;
  try {
    request = await createWorkerIdKitRequest({
      appId: WORLD_ID_APP_ID,
      rpId: WORLD_ID_RP_ID,
      signingKeyHex: WORLD_ID_RP_SIGNING_KEY,
      action: WORLD_ID_WORKER_ACTION,
      environment: WORLD_ID_ENVIRONMENT as WorldIdKitEnvironment,
      signal: worker.id,
    });
  } catch {
    throw new HttpError(503, 'world_id_unavailable', 'Worker verification could not be started.');
  }
  const nonce = request.rp_context?.nonce;
  assert(typeof nonce === 'string' && nonce.length > 0, 503, 'world_id_invalid_context', 'Worker verification could not be started.');
  const challengeId = uuid();
  const requestExpiry = Number(request.rp_context.expires_at) * 1000;
  const expiresAt = new Date(Math.min(Date.now() + 10 * 60 * 1000, requestExpiry));
  assert(Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now(), 503, 'world_id_invalid_context', 'Worker verification could not be started.');
  await db()`
    INSERT INTO idkit_challenges (id, worker_id, expected_nonce, expected_action, expected_environment, expires_at)
    VALUES (${challengeId}, ${worker.id}, ${nonce}, ${WORLD_ID_WORKER_ACTION}, ${WORLD_ID_ENVIRONMENT}, ${expiresAt})
  `;
  return { challengeId, request, expiresAt: expiresAt.toISOString() };
}

export async function completeWorkerVerification(session: Session, challengeId: string, idkitResult: unknown) {
  const [challenge] = await db()`
    SELECT id, worker_id, expected_nonce, expected_action, expected_environment, expires_at, consumed_at
    FROM idkit_challenges WHERE id = ${challengeId}
  `;
  assert(challenge && challenge.worker_id === session.workerId, 404, 'idkit_challenge_missing', 'Verification request was not found.');
  assert(!challenge.consumed_at && new Date(challenge.expires_at).getTime() > Date.now(), 409, 'idkit_challenge_expired', 'Verification request has expired or was already used.');

  await db().begin(async (tx) => {
    const [locked] = await tx`SELECT id, worker_id, expires_at, consumed_at FROM idkit_challenges WHERE id = ${challengeId} FOR UPDATE`;
    assert(locked && locked.worker_id === session.workerId, 404, 'idkit_challenge_missing', 'Verification request was not found.');
    assert(!locked.consumed_at && new Date(locked.expires_at).getTime() > Date.now(), 409, 'idkit_challenge_expired', 'Verification request has expired or was already used.');
    await tx`UPDATE idkit_challenges SET consumed_at = now() WHERE id = ${challengeId}`;
  });

  let verified: Awaited<ReturnType<typeof verifyWorkerIdKitResult>>;
  try {
    verified = await verifyWorkerIdKitResult({
      rpId: process.env.WORLD_ID_RP_ID!,
      expectedAction: challenge.expected_action,
      expectedEnvironment: challenge.expected_environment as WorldIdKitEnvironment,
      expectedSignal: challenge.worker_id,
      expectedNonce: challenge.expected_nonce,
      stagingVerificationToken: process.env.WORLD_ID_STAGING_VERIFICATION_TOKEN,
      idkitResult,
    });
  } catch (error) {
    if (error instanceof WorldIntegrationError && error.code === 'verification_unavailable') {
      throw new HttpError(503, 'idkit_verification_unavailable', 'World verification is temporarily unavailable. Start a new request and try again.');
    }
    if (error instanceof WorldIntegrationError && error.code === 'configuration') {
      throw new HttpError(503, 'world_id_not_configured', 'Worker verification is temporarily unavailable.');
    }
    throw new HttpError(400, 'idkit_proof_invalid', 'World could not verify this worker proof. Start a new verification request and try again.');
  }

  try {
    await db().begin(async (tx) => {
      const [worker] = await tx`SELECT id, status, wallet_address FROM workers WHERE id = ${challenge.worker_id} FOR UPDATE`;
      assert(worker, 404, 'worker_missing', 'Worker profile was not found.');
      assert(worker.wallet_address, 409, 'worker_wallet_required', 'Link a Sui payout wallet before verifying this worker.');
      assert(worker.status === 'PENDING', 409, 'worker_already_verified', 'This worker is already verified.');
      await tx`
        UPDATE workers SET status = 'VERIFIED', idkit_nullifier = ${verified.nullifier}, idkit_verified_at = now()
        WHERE id = ${challenge.worker_id}
      `;
      await tx`
        INSERT INTO audit_events (actor_type, actor_id, event_type)
        VALUES ('worker', ${challenge.worker_id}, 'worker_verified')
      `;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'human_already_enrolled', 'This human verification is already linked to a worker account.');
    throw error;
  }
  // The nullifier stays server-side; callers receive only activation status.
  return { workerId: challenge.worker_id, status: 'VERIFIED' as const };
}

export async function workerForSession(session: Session) {
  assert(session.workerId, 401, 'worker_required', 'A worker profile is required.');
  const [worker] = await db()`
    SELECT id, display_name, category, area, skills, status, wallet_address, wallet_verified_at, idkit_verified_at
    FROM workers WHERE id = ${session.workerId}
  `;
  assert(worker, 404, 'worker_missing', 'Worker profile was not found.');
  return worker;
}

export async function ownerForSession(session: Session) {
  assert(session.ownerId, 401, 'owner_required', 'An owner session is required.');
  const [owner] = await db()`
    SELECT id, wallet_address, wallet_verified_at FROM owners WHERE id = ${session.ownerId}
  `;
  assert(owner, 404, 'owner_missing', 'Owner account was not found.');
  return owner;
}

async function bindWorkerWallet(tx: postgres.TransactionSql, workerId: string, address: string) {
  const [worker] = await tx`SELECT id, wallet_address FROM workers WHERE id = ${workerId} FOR UPDATE`;
  assert(worker, 404, 'worker_missing', 'Worker profile was not found.');
  if (worker.wallet_address && worker.wallet_address !== address) {
    const [active] = await tx`SELECT 1 FROM tasks WHERE assigned_worker_id = ${workerId} AND state IN ('ASSIGNED','FUNDING','FUNDED','SUBMITTED','REVIEW') LIMIT 1`;
    assert(!active, 409, 'wallet_change_blocked', 'The payout wallet cannot change while this worker has an active task.');
  }
  await tx`UPDATE workers SET wallet_address = ${address}, wallet_verified_at = now() WHERE id = ${workerId}`;
}

async function bindOwnerWallet(tx: postgres.TransactionSql, ownerId: string, address: string) {
  const [owner] = await tx`SELECT id, wallet_address FROM owners WHERE id = ${ownerId} FOR UPDATE`;
  assert(owner, 404, 'owner_missing', 'Owner account was not found.');
  if (owner.wallet_address && owner.wallet_address !== address) {
    const [active] = await tx`SELECT 1 FROM tasks WHERE owner_id = ${ownerId} AND state IN ('OPEN','ASSIGNED','FUNDING','FUNDED','SUBMITTED','REVIEW') LIMIT 1`;
    assert(!active, 409, 'wallet_change_blocked', 'The funding wallet cannot change while this owner has an active task.');
  }
  await tx`UPDATE owners SET wallet_address = ${address}, wallet_verified_at = now() WHERE id = ${ownerId}`;
}

async function attachRecoveredAccount(
  tx: postgres.TransactionSql,
  sessionId: string,
  column: 'worker_id' | 'owner_id',
  accountId: string,
  currentId: string | null,
) {
  assert(!currentId || currentId === accountId, 409, 'session_account_conflict', 'This browser session is linked to another account of that type.');
  if (column === 'worker_id') await tx`UPDATE sessions SET worker_id = ${accountId} WHERE id = ${sessionId}`;
  else await tx`UPDATE sessions SET owner_id = ${accountId} WHERE id = ${sessionId}`;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505';
}
