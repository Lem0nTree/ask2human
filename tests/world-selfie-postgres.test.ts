import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { closeDbForTests } from '../app/lib/server/db';
import type { AgentPrincipal } from '../app/lib/server/marketplace';
import type { Session } from '../app/lib/server/session';

// This suite only runs against an explicitly disposable database. It never
// falls back to the development or deployment DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const serverOnlyLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);

const identityConfigKeys = [
  'WORLD_ID_APP_ID',
  'WORLD_ID_RP_ID',
  'WORLD_ID_RP_SIGNING_KEY',
  'WORLD_ID_WORKER_ACTION',
  'WORLD_ID_ENVIRONMENT',
  'WORLD_ID_STAGING_VERIFICATION_TOKEN',
] as const;

test('Selfie Check provenance gates current eligibility while preserving old worker access', { skip: !testDatabaseUrl }, async () => {
  const schema = `ask2human_selfie_test_${randomUUID().replaceAll('-', '')}`;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const priorAskDatabaseUrl = process.env.ASK2HUMAN_DATABASE_URL;
  const priorConfig = Object.fromEntries(identityConfigKeys.map((key) => [key, process.env[key]]));
  const admin = postgres(testDatabaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let scoped: ReturnType<typeof postgres> | undefined;
  const wallet = (hex: string) => `0x${hex.repeat(64)}`;
  const sessionFor = (workerId: string): Session => ({
    id: randomUUID(),
    rawToken: 'test-only-session',
    csrfToken: 'test-only-csrf',
    workerId,
    ownerId: null,
    expiresAt: new Date(Date.now() + 60_000),
  });

  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(testDatabaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.ASK2HUMAN_DATABASE_URL = scopedUrl.toString();
    scoped = postgres(scopedUrl.toString(), { max: 6, idle_timeout: 2, connect_timeout: 8, onnotice: () => {}, prepare: false });

    await scoped`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const migrationFiles = (await readdir(resolve('infra/migrations')))
      .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();
    for (const file of migrationFiles) {
      const source = await readFile(resolve('infra/migrations', file), 'utf8');
      await scoped.begin(async (tx) => {
        await tx.unsafe(source, [], { prepare: false });
        await tx`INSERT INTO schema_migrations (version) VALUES (${file.replace(/\.sql$/i, '')})`;
      });
    }

    const { getBrowserState, searchWorkers } = await import('../app/lib/server/marketplace');
    const { getExperienceTask, getWorkerDashboard } = await import('../app/lib/server/experience');
    const { completeWorkerVerification, startWorkerVerification } = await import('../app/lib/server/identity');

    const ownerId = randomUUID();
    const agentId = randomUUID();
    const legacyWorkerId = randomUUID();
    const staleWorkerId = randomUUID();
    const fundedTaskId = randomUUID();
    const oldNullifier = (hex: string) => `0x${hex.repeat(64)}`;
    const action = 'worker-selfie-test';
    const ownerWallet = wallet('3');
    const legacyWallet = wallet('1');
    const staleWallet = wallet('2');

    process.env.WORLD_ID_APP_ID = 'app_test_selfie';
    process.env.WORLD_ID_RP_ID = 'rp_test_selfie';
    process.env.WORLD_ID_RP_SIGNING_KEY = '11'.repeat(32);
    process.env.WORLD_ID_WORKER_ACTION = action;
    process.env.WORLD_ID_ENVIRONMENT = 'production';
    delete process.env.WORLD_ID_STAGING_VERIFICATION_TOKEN;

    await scoped`
      INSERT INTO owners (id, oidc_issuer, oidc_subject, wallet_address, wallet_verified_at)
      VALUES (${ownerId}, 'https://test.invalid', ${`owner-${ownerId}`}, ${ownerWallet}, now())
    `;
    await scoped`
      INSERT INTO agents (id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic,
                          asset, network, decimals, legacy_read_only, authorization_required)
      VALUES (${agentId}, ${ownerId}, 'Selfie test agent', ${'a'.repeat(64)},
              ${scoped.array(['search_workers'])}, ${scoped.array(['home'])}, 1000000, 1000000,
              'USDC', 'mainnet', 6, false, false)
    `;
    await scoped`
      INSERT INTO workers (id, display_name, category, area, status, wallet_address, wallet_verified_at,
                           idkit_nullifier, idkit_verified_at)
      VALUES
        (${legacyWorkerId}, 'Legacy worker', 'home', 'test area', 'VERIFIED', ${legacyWallet}, now(), ${oldNullifier('a')}, now()),
        (${staleWorkerId}, 'Stale worker', 'home', 'test area', 'VERIFIED', ${staleWallet}, now(), ${oldNullifier('b')}, now())
    `;
    await scoped`
      INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline,
                         state, assigned_worker_id, asset, network, decimals, legacy_read_only, review_window_ms, reject_split_bps)
      VALUES (${fundedTaskId}, ${ownerId}, ${agentId}, 'Already funded task', 'Historical funded task remains readable.',
              'home', 'test area', ${scoped.json(['Complete the task'])}, 1000000,
              ${new Date(Date.now() + 60 * 60 * 1000)}, 'FUNDED', ${staleWorkerId}, 'USDC', 'mainnet', 6, false, 300000, 5000)
    `;
    await scoped`
      INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
                               brief_hash, deadline, status, asset, decimals)
      VALUES (${fundedTaskId}, 'mainnet', '0xpackage', '0xcoin::usdc::USDC', 1000000, ${ownerWallet}, ${staleWallet},
              ${'c'.repeat(64)}, ${new Date(Date.now() + 60 * 60 * 1000)}, 'FUNDED', 'USDC', 6)
    `;

    const legacySession = sessionFor(legacyWorkerId);
    const staleSession = sessionFor(staleWorkerId);
    const legacyState = await getBrowserState(legacySession);
    assert.equal(legacyState.session.worker?.worldVerified, false);

    // A worker with no current provenance can still see a funded task and its
    // settlement history. New eligibility gates are applied to new work only.
    const dashboard = await getWorkerDashboard(staleSession);
    assert.equal(dashboard.worker.status, 'VERIFIED');
    assert.equal(dashboard.payments[0]?.taskId, fundedTaskId);
    const fundedTask = await getExperienceTask(fundedTaskId, staleSession);
    assert.equal(fundedTask.state, 'FUNDED');
    assert.equal(fundedTask.worker?.worldVerified, false);

    const agent: AgentPrincipal = {
      id: agentId,
      ownerId,
      name: 'Selfie test agent',
      scopes: ['search_workers'],
      categories: ['home'],
      maxTaskAtomic: '1000000',
      totalBudgetAtomic: '1000000',
    };
    const searchResult = await searchWorkers(agent, { category: 'home' });
    assert.deepEqual(searchResult, []);

    const verification = await startWorkerVerification(legacySession);
    const nonce = verification.request.rp_context.nonce;
    const nullifier = oldNullifier('c');
    const signalHash = hashSignal(legacyWorkerId);
    const idkitResult = {
      protocol_version: '4.0',
      action,
      environment: 'production',
      nonce,
      responses: [{
        identifier: 'selfie',
        proof: ['1', '2', '3', '4', '5'],
        nullifier,
        issuer_schema_id: 11,
        sybil_score: 17,
        signal_hash: signalHash,
      }],
      integrity_bundle: {
        version: 2,
        signature_format: 'apple_app_attest',
        timestamp: 1_700_000_000,
        signature: 'test-signature',
        jwt: 'test.jwt.signature',
      },
    };
    const priorFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({
        success: true,
        action,
        environment: 'production',
        nullifier,
        results: [{ success: true, identifier: 'selfie', nullifier }],
      });
    }) as typeof fetch;
    try {
      await completeWorkerVerification(legacySession, verification.challengeId, idkitResult);
    } finally {
      globalThis.fetch = priorFetch;
    }
    assert.equal(fetchCalls, 1);
    const [reverified] = await scoped`
      SELECT status, idkit_verified_environment, idkit_credential, idkit_credential_schema,
             idkit_sybil_score, idkit_action
      FROM workers WHERE id = ${legacyWorkerId}
    `;
    assert.equal(reverified.status, 'VERIFIED');
    assert.equal(reverified.idkit_verified_environment, 'production');
    assert.equal(reverified.idkit_credential, 'selfie');
    assert.equal(Number(reverified.idkit_credential_schema), 11);
    assert.equal(String(reverified.idkit_sybil_score), '17');
    assert.equal(reverified.idkit_action, action);
    const currentState = await getBrowserState(legacySession);
    assert.equal(currentState.session.worker?.worldVerified, true);

    // A challenge opened in the old staging window is rejected after the
    // deployment switches to production, before any proof reaches World.
    const staleAction = action;
    process.env.WORLD_ID_ENVIRONMENT = 'staging';
    process.env.WORLD_ID_STAGING_VERIFICATION_TOKEN = 'test-staging-token';
    const staleChallenge = await startWorkerVerification(staleSession);
    process.env.WORLD_ID_ENVIRONMENT = 'production';
    delete process.env.WORLD_ID_STAGING_VERIFICATION_TOKEN;
    let staleFetchCalls = 0;
    const beforeStaleFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      staleFetchCalls += 1;
      return Response.json({ success: true });
    }) as typeof fetch;
    try {
      await assert.rejects(
        completeWorkerVerification(staleSession, staleChallenge.challengeId, { action: staleAction }),
        (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'idkit_challenge_stale',
      );
    } finally {
      globalThis.fetch = beforeStaleFetch;
    }
    assert.equal(staleFetchCalls, 0);
    const [unchangedChallenge] = await scoped`SELECT consumed_at FROM idkit_challenges WHERE id = ${staleChallenge.challengeId}`;
    assert.equal(unchangedChallenge.consumed_at, null);
  } finally {
    await closeDbForTests();
    if (scoped) await scoped.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 1 });
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (priorAskDatabaseUrl === undefined) delete process.env.ASK2HUMAN_DATABASE_URL;
    else process.env.ASK2HUMAN_DATABASE_URL = priorAskDatabaseUrl;
    for (const key of identityConfigKeys) {
      const value = priorConfig[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
