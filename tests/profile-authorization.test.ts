import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { closeDbForTests } from '../app/lib/server/db';
import type { Session } from '../app/lib/server/session';

try {
  process.loadEnvFile('.env');
} catch {
  // Integration tests are skipped when no local database configuration exists.
}

function isLoopbackPostgresUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127);
  } catch {
    return false;
  }
}

const explicitTestDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const fallbackDatabaseUrl = process.env.DATABASE_URL;
const databaseUrl = explicitTestDatabaseUrl || (isLoopbackPostgresUrl(fallbackDatabaseUrl) ? fallbackDatabaseUrl : undefined);
const databaseSkipReason = databaseUrl
  ? false
  : fallbackDatabaseUrl
    ? 'DATABASE_URL is not loopback; set TEST_DATABASE_URL explicitly to opt in.'
    : 'Set TEST_DATABASE_URL or use a loopback DATABASE_URL for this integration test.';

test('profile policy hash is stable across reordered JSON keys', async () => {
  const originalAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://test.invalid';
  try {
    const { canonicalProfilePolicy, profilePolicyHash } = await import('../app/lib/server/profile-authorization');
    const policy = canonicalProfilePolicy({
      ownerId: randomUUID(),
      agentId: randomUUID(),
      name: 'reordering fixture',
      categories: ['home', 'research'],
      scopes: ['create_task', 'search_workers'],
      maxTaskAtomic: '10000000',
      totalBudgetAtomic: '25000000',
    });
    const reordered = {
      domain: policy.domain,
      decimals: policy.decimals,
      network: policy.network,
      asset: policy.asset,
      totalBudgetAtomic: policy.totalBudgetAtomic,
      maxTaskAtomic: policy.maxTaskAtomic,
      scopes: [...policy.scopes].reverse(),
      categories: [...policy.categories].reverse(),
      name: policy.name,
      agentId: policy.agentId,
      ownerId: policy.ownerId,
      version: policy.version,
    };
    assert.equal(profilePolicyHash(reordered), profilePolicyHash(policy));
  } finally {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  }
});

test('profile authorization signs and consumes a disposable database challenge', { skip: databaseSkipReason }, async () => {
  const schema = `profile_auth_test_${randomUUID().replaceAll('-', '')}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAskDatabaseUrl = process.env.ASK2HUMAN_DATABASE_URL;
  const originalAppUrl = process.env.APP_URL;
  const admin = postgres(databaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let isolated: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const schemaUrl = new URL(databaseUrl!);
    schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = schemaUrl.toString();
    process.env.ASK2HUMAN_DATABASE_URL = schemaUrl.toString();
    process.env.APP_URL = 'https://test.invalid';
    isolated = postgres(schemaUrl.toString(), { max: 6, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });

    await isolated`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const migrationFiles = (await readdir(resolve('infra/migrations')))
      .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();
    for (const file of migrationFiles) {
      const source = await readFile(resolve('infra/migrations', file), 'utf8');
      await isolated.begin(async (tx) => {
        await tx.unsafe(source, [], { prepare: false });
        await tx`INSERT INTO schema_migrations (version) VALUES (${file.replace(/\.sql$/i, '')})`;
      });
    }

    const {
      startAgentAuthorization,
      createAuthorizedAgent,
      authorizeExistingAgent,
      isAgentPostingAuthorized,
    } = await import('../app/lib/server/profile-authorization');
    const ownerId = randomUUID();
    const sessionId = randomUUID();
    const ownerKey = new Ed25519Keypair();
    const wrongKey = new Ed25519Keypair();
    const ownerWallet = ownerKey.toSuiAddress().toLowerCase();
    const ownerSession: Session = {
      id: sessionId,
      rawToken: 'profile-auth-test-session',
      csrfToken: 'profile-auth-test-csrf',
      workerId: null,
      ownerId,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await isolated`
      INSERT INTO owners (id, oidc_issuer, oidc_subject, wallet_address, wallet_verified_at)
      VALUES (${ownerId}, 'https://test.invalid', ${`profile-auth-${ownerId}`}, ${ownerWallet}, now())
    `;
    await isolated`
      INSERT INTO sessions (id, token_hash, csrf_hash, owner_id, expires_at)
      VALUES (${sessionId}, ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${ownerId}, ${ownerSession.expiresAt})
    `;

    const newProfile = {
      name: 'signed profile',
      categories: ['home', 'research'],
      maxTaskAtomic: '10000000',
      totalBudgetAtomic: '25000000',
    };
    const challenge = await startAgentAuthorization(ownerSession, newProfile);
    assert.match(challenge.message, /Challenge expires:/);
    assert.match(challenge.message, /Per-task limit: 10 USDC \(10000000 atomic units\)/);
    assert.match(challenge.message, /does not transfer tokens or fund a task/);
    assert.match(challenge.message, /Separate owner wallet funding is required only after a worker is selected/);
    const signed = await ownerKey.signPersonalMessage(new TextEncoder().encode(challenge.message));
    const created = await createAuthorizedAgent(ownerSession, { ...newProfile, challengeId: challenge.challengeId, signature: signed.signature });
    assert.match(created.apiKey ?? '', /^gw_live_/);
    assert.equal(created.authorizationRequired, false);

    const [createdRow] = await isolated`
      SELECT id, owner_id, name, categories, scopes, max_task_atomic, total_budget_atomic,
             asset, network, decimals, authorization_required, authorization_policy_hash,
             authorization_wallet, authorization_signature, authorization_message, authorized_at
      FROM agents WHERE id = ${created.agentId}
    `;
    assert.equal(createdRow.owner_id, ownerId);
    assert.equal(createdRow.authorization_required, false);
    assert.equal(createdRow.authorization_wallet, ownerWallet);
    assert.equal(createdRow.authorization_signature, signed.signature);
    assert.ok(createdRow.authorized_at);
    const [consumed] = await isolated`SELECT consumed_at FROM agent_authorization_challenges WHERE id = ${challenge.challengeId}`;
    assert.ok(consumed.consumed_at);
    assert.equal(isAgentPostingAuthorized(createdRow, ownerWallet), true);

    await assert.rejects(
      createAuthorizedAgent(ownerSession, { ...newProfile, challengeId: challenge.challengeId, signature: signed.signature }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'profile_authorization_challenge_expired'),
    );

    const existingAgentId = randomUUID();
    await isolated`
      INSERT INTO agents (
        id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic,
        asset, network, decimals, legacy_read_only
      ) VALUES (
        ${existingAgentId}, ${ownerId}, 'existing unsigned profile', ${'c'.repeat(64)},
        ${isolated.array(['search_workers', 'create_task'])}, ${isolated.array(['home'])},
        4000000, 9000000, 'USDC', 'mainnet', 6, false
      )
    `;
    const existingChallenge = await startAgentAuthorization(ownerSession, { agentId: existingAgentId });
    const existingSigned = await ownerKey.signPersonalMessage(new TextEncoder().encode(existingChallenge.message));
    const authorized = await authorizeExistingAgent(ownerSession, {
      agentId: existingAgentId,
      challengeId: existingChallenge.challengeId,
      signature: existingSigned.signature,
    });
    assert.equal(authorized.authorizationRequired, false);
    const [authorizedRow] = await isolated`SELECT * FROM agents WHERE id = ${existingAgentId}`;
    assert.equal(isAgentPostingAuthorized(authorizedRow, ownerWallet), true);

    const wrongWalletChallenge = await startAgentAuthorization(ownerSession, {
      name: 'wrong wallet profile',
      categories: ['home'],
      maxTaskAtomic: '1000000',
      totalBudgetAtomic: '2000000',
    });
    const wrongSignature = await wrongKey.signPersonalMessage(new TextEncoder().encode(wrongWalletChallenge.message));
    await assert.rejects(
      createAuthorizedAgent(ownerSession, {
        name: 'wrong wallet profile', categories: ['home'], maxTaskAtomic: '1000000', totalBudgetAtomic: '2000000',
        challengeId: wrongWalletChallenge.challengeId, signature: wrongSignature.signature,
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'profile_authorization_signature_invalid'),
    );
    const [wrongWalletState] = await isolated`SELECT consumed_at FROM agent_authorization_challenges WHERE id = ${wrongWalletChallenge.challengeId}`;
    assert.equal(wrongWalletState.consumed_at, null);
    const rightAfterWrong = await createAuthorizedAgent(ownerSession, {
      name: 'wrong wallet profile', categories: ['home'], maxTaskAtomic: '1000000', totalBudgetAtomic: '2000000',
      challengeId: wrongWalletChallenge.challengeId,
      signature: (await ownerKey.signPersonalMessage(new TextEncoder().encode(wrongWalletChallenge.message))).signature,
    });
    assert.equal(rightAfterWrong.authorizationRequired, false);

    const expiredChallenge = await startAgentAuthorization(ownerSession, {
      name: 'expired profile', categories: ['home'], maxTaskAtomic: '1000000', totalBudgetAtomic: '2000000',
    });
    await isolated`UPDATE agent_authorization_challenges SET expires_at = now() - interval '1 second' WHERE id = ${expiredChallenge.challengeId}`;
    const expiredSignature = await ownerKey.signPersonalMessage(new TextEncoder().encode(expiredChallenge.message));
    await assert.rejects(
      createAuthorizedAgent(ownerSession, {
        name: 'expired profile', categories: ['home'], maxTaskAtomic: '1000000', totalBudgetAtomic: '2000000',
        challengeId: expiredChallenge.challengeId, signature: expiredSignature.signature,
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'profile_authorization_challenge_expired'),
    );

    const tamperedChallenge = await startAgentAuthorization(ownerSession, {
      name: 'tampered profile', categories: ['home'], maxTaskAtomic: '1000000', totalBudgetAtomic: '2000000',
    });
    await isolated`UPDATE agent_authorization_challenges SET policy = jsonb_set(policy, '{name}', '"changed"'::jsonb) WHERE id = ${tamperedChallenge.challengeId}`;
    const tamperedSignature = await ownerKey.signPersonalMessage(new TextEncoder().encode(tamperedChallenge.message));
    await assert.rejects(
      createAuthorizedAgent(ownerSession, {
        name: 'tampered profile', categories: ['home'], maxTaskAtomic: '1000000', totalBudgetAtomic: '2000000',
        challengeId: tamperedChallenge.challengeId, signature: tamperedSignature.signature,
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'profile_authorization_terms_changed'),
    );

    await isolated`UPDATE agents SET name = 'changed after authorization' WHERE id = ${created.agentId}`;
    const [changedRow] = await isolated`SELECT * FROM agents WHERE id = ${created.agentId}`;
    assert.equal(isAgentPostingAuthorized(changedRow, ownerWallet), false);
    await isolated`UPDATE owners SET wallet_address = ${wrongKey.toSuiAddress().toLowerCase()}, wallet_verified_at = now() WHERE id = ${ownerId}`;
    assert.equal(isAgentPostingAuthorized(changedRow, wrongKey.toSuiAddress()), false);
  } finally {
    await closeDbForTests();
    if (isolated) await isolated.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 1 });
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAskDatabaseUrl === undefined) delete process.env.ASK2HUMAN_DATABASE_URL;
    else process.env.ASK2HUMAN_DATABASE_URL = originalAskDatabaseUrl;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  }
});
