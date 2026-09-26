import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { db } from './db';
import { assert, HttpError } from './errors';
import { publicAppOrigin, randomToken, sha256, uuid } from './security';
import type { Session } from './session';
import type { AgentToolName } from './schemas';

export const PROFILE_ASSET = 'USDC' as const;
export const PROFILE_NETWORK = 'mainnet' as const;
export const PROFILE_DECIMALS = 6 as const;
export const PROFILE_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

/** Every profile receives the same least-privilege posting scopes. */
export const PROFILE_SCOPES = [
  'search_workers',
  'create_task',
  'get_task',
  'request_hire',
  'review_submission',
  'request_release',
  'list_applicants',
  'select_worker',
] as const satisfies readonly AgentToolName[];

type ProfilePolicy = {
  version: 1;
  ownerId: string;
  agentId: string;
  name: string;
  categories: string[];
  scopes: string[];
  maxTaskAtomic: string;
  totalBudgetAtomic: string;
  asset: typeof PROFILE_ASSET;
  network: typeof PROFILE_NETWORK;
  decimals: typeof PROFILE_DECIMALS;
  domain: string;
};

export type ProfileAgentRow = {
  id: string;
  owner_id?: string;
  ownerId?: string;
  name: string;
  categories: string[];
  scopes: string[];
  max_task_atomic?: string | number | bigint;
  total_budget_atomic?: string | number | bigint;
  maxTaskAtomic?: string | number | bigint;
  totalBudgetAtomic?: string | number | bigint;
  asset?: string | null;
  network?: string | null;
  decimals?: string | number | null;
  authorization_required?: boolean | null;
  authorization_policy_hash?: string | null;
  authorization_wallet?: string | null;
  authorization_signature?: string | null;
  authorization_message?: string | null;
  authorized_at?: Date | string | null;
};

type NewProfileAuthorization = {
  name: string;
  categories: string[];
  maxTaskAtomic: string;
  totalBudgetAtomic: string;
};

type ExistingProfileAuthorization = { agentId: string };

export type StartProfileAuthorizationInput = NewProfileAuthorization | ExistingProfileAuthorization;

type ChallengeRow = {
  id: string;
  session_id: string;
  owner_id: string;
  agent_id: string;
  purpose: 'CREATE' | 'AUTHORIZE';
  policy_hash: string;
  policy: ProfilePolicy;
  wallet_address: string;
  challenge_text: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

function normalizedWallet(value: string): string {
  return value.toLowerCase();
}

function normalizedCategories(categories: readonly string[]): string[] {
  return [...new Set(categories.map((category) => String(category)))].sort();
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => String(scope)))].sort();
}

function formatUsdcAtomic(value: string): string {
  try {
    const atomic = BigInt(value);
    const whole = atomic / 1_000_000n;
    const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : String(whole);
  } catch {
    return value;
  }
}

function profileDomain(): string {
  return new URL(publicAppOrigin()).host;
}

function amountFromAgent(agent: ProfileAgentRow, short: 'max' | 'total'): string {
  const value = short === 'max' ? agent.max_task_atomic ?? agent.maxTaskAtomic : agent.total_budget_atomic ?? agent.totalBudgetAtomic;
  assert(value !== undefined && value !== null, 500, 'profile_authorization_required', 'The hiring profile authorization policy is incomplete. Authorize this profile again.');
  return String(value);
}

/**
 * Build the policy that a profile signature authorizes. The explicit property
 * order is part of the signed format; arrays are sorted because their order is
 * not meaningful to the marketplace policy.
 */
export function canonicalProfilePolicy(input: {
  ownerId: string;
  agentId: string;
  name: string;
  categories: readonly string[];
  scopes: readonly string[];
  maxTaskAtomic: string | number | bigint;
  totalBudgetAtomic: string | number | bigint;
  asset?: string | null;
  network?: string | null;
  decimals?: string | number | null;
}): ProfilePolicy {
  return {
    version: 1,
    ownerId: String(input.ownerId),
    agentId: String(input.agentId),
    name: String(input.name),
    categories: normalizedCategories(input.categories),
    scopes: normalizedScopes(input.scopes),
    maxTaskAtomic: String(input.maxTaskAtomic),
    totalBudgetAtomic: String(input.totalBudgetAtomic),
    asset: (input.asset ?? PROFILE_ASSET) as typeof PROFILE_ASSET,
    network: (input.network ?? PROFILE_NETWORK) as typeof PROFILE_NETWORK,
    decimals: Number(input.decimals ?? PROFILE_DECIMALS) as typeof PROFILE_DECIMALS,
    domain: profileDomain(),
  };
}

export function profilePolicyHash(policy: ProfilePolicy): string {
  // PostgreSQL jsonb does not preserve object insertion order. Project every
  // field in the signed order so a challenge survives a database round trip.
  const canonical = {
    version: policy.version,
    ownerId: String(policy.ownerId),
    agentId: String(policy.agentId),
    name: String(policy.name),
    categories: normalizedCategories(policy.categories),
    scopes: normalizedScopes(policy.scopes),
    maxTaskAtomic: String(policy.maxTaskAtomic),
    totalBudgetAtomic: String(policy.totalBudgetAtomic),
    asset: policy.asset,
    network: policy.network,
    decimals: Number(policy.decimals),
    domain: policy.domain,
  };
  return sha256(JSON.stringify(canonical));
}

function validateCanonicalPolicy(policy: ProfilePolicy): void {
  assert(policy.asset === PROFILE_ASSET && policy.network === PROFILE_NETWORK && policy.decimals === PROFILE_DECIMALS,
    409, 'profile_authorization_terms_changed', 'This hiring profile no longer matches its signed mainnet USDC policy. Authorize it again.');
  assert(typeof policy.ownerId === 'string' && policy.ownerId.length > 0, 409, 'profile_authorization_terms_changed', 'This hiring profile authorization is missing its owner binding. Authorize it again.');
  assert(policy.domain === profileDomain(), 409, 'profile_authorization_terms_changed', 'This hiring profile was authorized for another domain. Authorize it again.');
}

function policyFromAgent(agent: ProfileAgentRow): ProfilePolicy {
  return canonicalProfilePolicy({
    ownerId: String(agent.owner_id ?? agent.ownerId ?? ''),
    agentId: agent.id,
    name: agent.name,
    categories: agent.categories,
    scopes: agent.scopes,
    maxTaskAtomic: amountFromAgent(agent, 'max'),
    totalBudgetAtomic: amountFromAgent(agent, 'total'),
    asset: agent.asset,
    network: agent.network,
    decimals: agent.decimals,
  });
}

function assertNewPolicyInput(policy: ProfilePolicy, input: NewProfileAuthorization): void {
  const expected = canonicalProfilePolicy({
    ownerId: policy.ownerId,
    agentId: policy.agentId,
    name: input.name,
    categories: input.categories,
    scopes: PROFILE_SCOPES,
    maxTaskAtomic: input.maxTaskAtomic,
    totalBudgetAtomic: input.totalBudgetAtomic,
    asset: PROFILE_ASSET,
    network: PROFILE_NETWORK,
    decimals: PROFILE_DECIMALS,
  });
  assert(profilePolicyHash(expected) === profilePolicyHash(policy), 409, 'profile_authorization_terms_changed', 'The hiring profile fields changed after signing. Start a new authorization.');
}

function challengeMessage(policy: ProfilePolicy, wallet: string, expiresAt: Date): string {
  const nonce = randomToken(24);
  return [
    'ask2human hiring profile posting authorization',
    `Domain: ${policy.domain}`,
    `Profile: ${policy.agentId}`,
    `Name: ${policy.name}`,
    `Categories: ${policy.categories.join(',')}`,
    `Scopes: ${policy.scopes.join(',')}`,
    `Per-task limit: ${formatUsdcAtomic(policy.maxTaskAtomic)} ${policy.asset} (${policy.maxTaskAtomic} atomic units)`,
    `Total budget limit: ${formatUsdcAtomic(policy.totalBudgetAtomic)} ${policy.asset} (${policy.totalBudgetAtomic} atomic units)`,
    `Asset: ${policy.asset}`,
    `Network: ${policy.network}`,
    `Decimals: ${policy.decimals}`,
    `Wallet: ${wallet}`,
    `Policy hash: ${profilePolicyHash(policy)}`,
    `Nonce: ${nonce}`,
    `Challenge expires: ${expiresAt.toISOString()}`,
    'Purpose: authorize this profile to post marketplace tasks.',
    'Accepted authorization persists for these limits until the profile policy or owner wallet changes.',
    'This signature authorizes profile posting policy only. It does not transfer tokens or fund a task.',
    'Separate owner wallet funding is required only after a worker is selected.',
  ].join('\n');
}

export async function startAgentAuthorization(session: Session, input: StartProfileAuthorizationInput) {
  const owner = await ownerForAuthorizationSession(session);
  const wallet = normalizedWallet(owner.wallet_address);
  const expiresAt = new Date(Date.now() + PROFILE_AUTHORIZATION_TTL_MS);
  const isExisting = 'agentId' in input;
  let agentId: string;
  let policy: ProfilePolicy;

  if (isExisting) {
    const [agent] = await db()`
      SELECT id, owner_id, name, categories, scopes, max_task_atomic, total_budget_atomic,
             asset, network, decimals
      FROM agents WHERE id = ${input.agentId} AND owner_id = ${owner.id}
    `;
    assert(agent, 404, 'agent_not_found', 'The hiring profile was not found for this owner.');
    agentId = agent.id;
    policy = policyFromAgent(agent as unknown as ProfileAgentRow);
  } else {
    agentId = uuid();
    assert(BigInt(input.maxTaskAtomic) <= BigInt(input.totalBudgetAtomic), 400, 'invalid_budget', 'Per-task limit cannot exceed total budget.');
    policy = canonicalProfilePolicy({
      agentId,
      ownerId: owner.id,
      name: input.name,
      categories: input.categories,
      scopes: PROFILE_SCOPES,
      maxTaskAtomic: input.maxTaskAtomic,
      totalBudgetAtomic: input.totalBudgetAtomic,
      asset: PROFILE_ASSET,
      network: PROFILE_NETWORK,
      decimals: PROFILE_DECIMALS,
    });
  }
  validateCanonicalPolicy(policy);
  const policyHash = profilePolicyHash(policy);
  const message = challengeMessage(policy, wallet, expiresAt);
  const challengeId = uuid();
  await db()`
    INSERT INTO agent_authorization_challenges (
      id, session_id, owner_id, agent_id, purpose, policy_hash, policy,
      wallet_address, challenge_text, expires_at
    ) VALUES (
      ${challengeId}, ${session.id}, ${owner.id}, ${agentId}, ${isExisting ? 'AUTHORIZE' : 'CREATE'},
      ${policyHash}, ${db().json(policy)}, ${wallet}, ${message}, ${expiresAt}
    )
  `;
  return { challengeId, message };
}

async function ownerForAuthorizationSession(session: Session) {
  assert(session.ownerId, 401, 'owner_required', 'An owner session is required.');
  const [owner] = await db()`
    SELECT id, wallet_address, wallet_verified_at FROM owners WHERE id = ${session.ownerId}
  `;
  assert(owner, 404, 'owner_missing', 'Owner account was not found.');
  assert(owner.wallet_address && owner.wallet_verified_at, 409, 'owner_wallet_required', 'Link and verify the owner wallet before authorizing a hiring profile.');
  return owner;
}

async function readChallenge(session: Session, challengeId: string): Promise<ChallengeRow> {
  const [challenge] = await db()`
    SELECT id, session_id, owner_id, agent_id, purpose, policy_hash, policy, wallet_address,
           challenge_text, expires_at, consumed_at
    FROM agent_authorization_challenges
    WHERE id = ${challengeId} AND session_id = ${session.id} AND owner_id = ${session.ownerId}
  ` as unknown as ChallengeRow[];
  assert(challenge, 404, 'profile_authorization_challenge_missing', 'The profile authorization challenge was not found.');
  assert(!challenge.consumed_at && new Date(challenge.expires_at).getTime() > Date.now(), 409, 'profile_authorization_challenge_expired', 'The profile authorization challenge expired or was already used. Start a new authorization.');
  return challenge;
}

async function verifyChallengeSignature(challenge: ChallengeRow, signature: string): Promise<void> {
  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.challenge_text), signature, {
      address: challenge.wallet_address,
      client: new SuiGrpcClient({
        network: 'mainnet',
        baseUrl: process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443',
      }),
    });
  } catch {
    throw new HttpError(400, 'profile_authorization_signature_invalid', 'The wallet signature does not match this profile authorization challenge.');
  }
}

function assertChallengePolicy(challenge: ChallengeRow): void {
  try {
    validateCanonicalPolicy(challenge.policy);
    assert(profilePolicyHash(challenge.policy) === challenge.policy_hash, 409, 'profile_authorization_terms_changed', 'The profile authorization challenge is invalid. Start a new authorization.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, 'profile_authorization_terms_changed', 'The profile authorization challenge is invalid. Start a new authorization.');
  }
}

async function consumeAuthorization(
  session: Session,
  challengeId: string,
  signature: string,
  createInput?: NewProfileAuthorization,
) {
  const challenge = await readChallenge(session, challengeId);
  assertChallengePolicy(challenge);
  await verifyChallengeSignature(challenge, signature);

  const apiKey = createInput ? `gw_live_${randomToken(32)}` : null;
  const result = await db().begin(async (tx) => {
    const [lockedChallenge] = await tx`
      SELECT id, session_id, owner_id, agent_id, purpose, policy_hash, policy,
             wallet_address, challenge_text, expires_at, consumed_at
      FROM agent_authorization_challenges
      WHERE id = ${challengeId} AND session_id = ${session.id} AND owner_id = ${session.ownerId}
      FOR UPDATE
    ` as unknown as ChallengeRow[];
    assert(lockedChallenge, 404, 'profile_authorization_challenge_missing', 'The profile authorization challenge was not found.');
    assert(!lockedChallenge.consumed_at && new Date(lockedChallenge.expires_at).getTime() > Date.now(), 409, 'profile_authorization_challenge_expired', 'The profile authorization challenge expired or was already used. Start a new authorization.');
    assertChallengePolicy(lockedChallenge);

    // Lock the owner before checking the wallet so a wallet relink cannot race
    // this signature into authorizing a profile under a different wallet.
    const [owner] = await tx`
      SELECT id, wallet_address, wallet_verified_at FROM owners WHERE id = ${lockedChallenge.owner_id} FOR UPDATE
    `;
    assert(owner && owner.id === session.ownerId, 401, 'owner_required', 'An owner session is required.');
    assert(owner.wallet_address && owner.wallet_verified_at, 409, 'owner_wallet_required', 'Link and verify the owner wallet before authorizing a hiring profile.');
    assert(normalizedWallet(owner.wallet_address) === normalizedWallet(lockedChallenge.wallet_address), 409, 'profile_authorization_wallet_changed', 'The owner wallet changed after this challenge was issued. Start a new authorization.');

    let agentId = lockedChallenge.agent_id;
    if (lockedChallenge.purpose === 'CREATE') {
      assert(createInput, 400, 'profile_authorization_input_required', 'Profile fields are required to create a hiring profile.');
      assertNewPolicyInput(lockedChallenge.policy, createInput);
      const [existing] = await tx`SELECT id FROM agents WHERE id = ${lockedChallenge.agent_id} FOR UPDATE`;
      assert(!existing, 409, 'profile_authorization_replayed', 'This profile authorization has already allocated a profile. Start a new authorization.');
      await tx`
        INSERT INTO agents (
          id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic,
          total_budget_atomic, asset, network, decimals, legacy_read_only,
          authorization_required, authorization_policy_hash, authorization_wallet,
          authorization_signature, authorization_message, authorized_at
        ) VALUES (
          ${lockedChallenge.agent_id}, ${lockedChallenge.owner_id}, ${lockedChallenge.policy.name},
          ${sha256(apiKey!)}, ${tx.array(lockedChallenge.policy.scopes)}, ${tx.array(lockedChallenge.policy.categories)},
          ${lockedChallenge.policy.maxTaskAtomic}, ${lockedChallenge.policy.totalBudgetAtomic},
          ${PROFILE_ASSET}, ${PROFILE_NETWORK}, ${PROFILE_DECIMALS}, false, false,
          ${lockedChallenge.policy_hash}, ${normalizedWallet(owner.wallet_address)}, ${signature},
          ${lockedChallenge.challenge_text}, now()
        )
      `;
    } else {
      assert(!createInput, 400, 'profile_authorization_input_invalid', 'Profile fields cannot be supplied when authorizing an existing profile.');
      const [agent] = await tx`
        SELECT id, owner_id, name, categories, scopes, max_task_atomic, total_budget_atomic,
               asset, network, decimals, authorization_required, authorization_policy_hash,
               authorization_wallet, authorization_signature, authorization_message, authorized_at
        FROM agents WHERE id = ${lockedChallenge.agent_id} AND owner_id = ${lockedChallenge.owner_id}
        FOR UPDATE
      ` as unknown as ProfileAgentRow[];
      assert(agent, 404, 'agent_not_found', 'The hiring profile was not found for this owner.');
      assert(profilePolicyHash(policyFromAgent(agent)) === lockedChallenge.policy_hash, 409, 'profile_authorization_terms_changed', 'The hiring profile changed after this challenge was issued. Start a new authorization.');
      await tx`
        UPDATE agents SET authorization_required = false,
          authorization_policy_hash = ${lockedChallenge.policy_hash},
          authorization_wallet = ${normalizedWallet(owner.wallet_address)},
          authorization_signature = ${signature},
          authorization_message = ${lockedChallenge.challenge_text},
          authorized_at = now()
        WHERE id = ${lockedChallenge.agent_id} AND owner_id = ${lockedChallenge.owner_id}
      `;
    }
    await tx`UPDATE agent_authorization_challenges SET consumed_at = now() WHERE id = ${challengeId} AND consumed_at IS NULL`;
    await tx`
      INSERT INTO audit_events (actor_type, actor_id, event_type, safe_detail)
      VALUES ('owner', ${lockedChallenge.owner_id}, 'agent_profile_authorized', ${tx.json({ agentId: lockedChallenge.agent_id })})
    `;
    return { agentId, apiKey };
  });

  if (result.apiKey) {
    return {
      agentId: result.agentId,
      apiKey: result.apiKey,
      scopes: [...PROFILE_SCOPES],
      categories: challenge.policy.categories,
      maxTaskAtomic: challenge.policy.maxTaskAtomic,
      totalBudgetAtomic: challenge.policy.totalBudgetAtomic,
      asset: PROFILE_ASSET,
      network: PROFILE_NETWORK,
      decimals: PROFILE_DECIMALS,
      authorizationRequired: false,
    };
  }
  return { agentId: result.agentId, authorizationRequired: false };
}

export async function createAuthorizedAgent(
  session: Session,
  input: NewProfileAuthorization & { challengeId: string; signature: string },
) {
  return consumeAuthorization(session, input.challengeId, input.signature, {
    name: input.name,
    categories: input.categories,
    maxTaskAtomic: input.maxTaskAtomic,
    totalBudgetAtomic: input.totalBudgetAtomic,
  });
}

export async function authorizeExistingAgent(session: Session, input: { agentId: string; challengeId: string; signature: string }) {
  const challenge = await readChallenge(session, input.challengeId);
  assert(challenge.purpose === 'AUTHORIZE' && challenge.agent_id === input.agentId, 409, 'profile_authorization_terms_changed', 'This challenge is bound to another hiring profile. Start a new authorization.');
  return consumeAuthorization(session, input.challengeId, input.signature);
}

/**
 * Synchronous trust-boundary check for task creation. The caller must select
 * every policy and authorization column in the same transaction and pass that
 * locked row here before reserving any budget.
 */
export function assertAgentPostingAuthorized(agent: ProfileAgentRow | Record<string, any>, ownerWallet: string): void {
  const typedAgent = agent as ProfileAgentRow;
  if (typedAgent.authorization_required !== false) {
    throw new HttpError(403, 'profile_authorization_required', 'Authorize this hiring profile with the linked owner wallet before posting a task.');
  }
  if (!typedAgent.authorization_policy_hash || !typedAgent.authorization_wallet || !typedAgent.authorization_signature || !typedAgent.authorization_message || !typedAgent.authorized_at) {
    throw new HttpError(403, 'profile_authorization_required', 'Authorize this hiring profile with the linked owner wallet before posting a task.');
  }
  let currentHash: string;
  try {
    currentHash = profilePolicyHash(policyFromAgent(typedAgent));
  } catch {
    throw new HttpError(403, 'profile_authorization_required', 'Authorize this hiring profile with the linked owner wallet before posting a task.');
  }
  if (currentHash !== typedAgent.authorization_policy_hash || normalizedWallet(ownerWallet) !== normalizedWallet(typedAgent.authorization_wallet)) {
    throw new HttpError(403, 'profile_authorization_required', 'The hiring profile policy or owner wallet changed. Authorize the profile again before posting a task.');
  }
}

/** Return the current trust-boundary result for read-only dashboard state. */
export function isAgentPostingAuthorized(agent: ProfileAgentRow | Record<string, any>, ownerWallet: string): boolean {
  try {
    assertAgentPostingAuthorized(agent, ownerWallet);
    return true;
  } catch {
    return false;
  }
}
