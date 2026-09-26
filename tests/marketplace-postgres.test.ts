import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { closeDbForTests } from '../app/lib/server/db';
import type { AgentPrincipal } from '../app/lib/server/marketplace';
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

// This fixture uses synthetic identity rows only in a random, disposable test schema.
test('PostgreSQL enforces atomic budgets, one-winner acceptance, and safe browser state', { skip: databaseSkipReason }, async () => {
  const testSchema = `groundwork_test_${randomUUID().replaceAll('-', '')}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAskDatabaseUrl = process.env.ASK2HUMAN_DATABASE_URL;
  const originalAppUrl = process.env.APP_URL;
  const originalWorldEnvironment = process.env.WORLD_ID_ENVIRONMENT;
  const originalWorkerAction = process.env.WORLD_ID_WORKER_ACTION;
  const admin = postgres(databaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let isolated: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA "${testSchema}"`);
    const schemaUrl = new URL(databaseUrl!);
    schemaUrl.searchParams.set('options', `-c search_path=${testSchema}`);
    process.env.DATABASE_URL = schemaUrl.toString();
    process.env.ASK2HUMAN_DATABASE_URL = schemaUrl.toString();
    isolated = postgres(schemaUrl.toString(), { max: 6, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
    process.env.WORLD_ID_ENVIRONMENT = 'production';
    process.env.WORLD_ID_WORKER_ACTION = 'test-worker-enrollment';

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

    const serverOnlyLoader = `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `;
    register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);
    const { createTaskForAgent, getBrowserState } = await import('../app/lib/server/marketplace');
    const { canonicalProfilePolicy, profilePolicyHash } = await import('../app/lib/server/profile-authorization');
    const { ownerSelectWorker } = await import('../app/lib/server/experience');
    const { startWalletChallenge, completeWalletChallenge } = await import('../app/lib/server/identity');

    const ownerId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const workerIds = [randomUUID(), randomUUID()];
    const workerWallets = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`];
    const privateNullifiers = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`];
    const ownerWallet = `0x${'33'.repeat(32)}`;
    const oidcSubjectFixture = `test-only-subject-${randomUUID()}`;
    process.env.APP_URL = 'https://test.invalid';
    const agentScopes = ['search_workers', 'create_task', 'get_task', 'request_hire', 'review_submission', 'request_release'];
    const agentCategories = ['home'];
    const policy = canonicalProfilePolicy({
      ownerId,
      agentId,
      name: 'test agent',
      categories: agentCategories,
      scopes: agentScopes,
      maxTaskAtomic: '100',
      totalBudgetAtomic: '100',
    });
    const policyHash = profilePolicyHash(policy);
    const otherPolicy = canonicalProfilePolicy({
      ownerId,
      agentId: otherAgentId,
      name: 'other test agent',
      categories: agentCategories,
      scopes: agentScopes,
      maxTaskAtomic: '100',
      totalBudgetAtomic: '100',
    });
    const otherPolicyHash = profilePolicyHash(otherPolicy);
    await isolated`
      INSERT INTO owners (id, oidc_issuer, oidc_subject, wallet_address, wallet_verified_at)
      VALUES (${ownerId}, 'https://test.invalid', ${oidcSubjectFixture}, ${ownerWallet}, now())
    `;
    await isolated`
      INSERT INTO agents (
        id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic,
        authorization_required, authorization_policy_hash, authorization_wallet,
        authorization_signature, authorization_message, authorized_at
      )
      VALUES
        (
          ${agentId}, ${ownerId}, 'test agent', ${'f'.repeat(64)}, ${isolated.array(agentScopes)}, ${isolated.array(agentCategories)}, 100, 100,
          false, ${policyHash}, ${ownerWallet}, 'test-only-signature', 'test-only-profile-authorization', now()
        ),
        (
          ${otherAgentId}, ${ownerId}, 'other test agent', ${'e'.repeat(64)}, ${isolated.array(agentScopes)}, ${isolated.array(agentCategories)}, 100, 100,
          false, ${otherPolicyHash}, ${ownerWallet}, 'test-only-signature', 'test-only-profile-authorization', now()
        )
    `;
    for (let index = 0; index < workerIds.length; index += 1) {
      await isolated`
        INSERT INTO workers (id, display_name, category, area, status, wallet_address, wallet_verified_at,
          idkit_nullifier, idkit_verified_at, idkit_verified_environment, idkit_credential,
          idkit_credential_schema, idkit_sybil_score, idkit_action)
        VALUES (${workerIds[index]}, ${`test worker ${index}`}, 'home', 'test area', 'VERIFIED', ${workerWallets[index]},
          now(), ${privateNullifiers[index]}, now(), 'production', 'selfie', 11, 7, 'test-worker-enrollment')
      `;
    }

    const recoveryWorkerId = randomUUID();
    const recoverySessionId = randomUUID();
    await isolated`
      INSERT INTO workers (id, display_name, category, area)
      VALUES (${recoveryWorkerId}, 'wallet recovery fixture', 'home', 'test area')
    `;
    await isolated`
      INSERT INTO sessions (id, token_hash, csrf_hash, worker_id, expires_at)
      VALUES (${recoverySessionId}, ${'c'.repeat(64)}, ${'d'.repeat(64)}, ${recoveryWorkerId}, ${new Date(Date.now() + 60_000)})
    `;
    const recoverySession: Session = {
      id: recoverySessionId, rawToken: 'test-only-session', csrfToken: 'test-only-csrf',
      workerId: recoveryWorkerId, ownerId: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const recoveryKey = new Ed25519Keypair();
    const walletChallenge = await startWalletChallenge(recoverySession, 'worker', recoveryKey.toSuiAddress());
    const signature = await recoveryKey.signPersonalMessage(new TextEncoder().encode(walletChallenge.message));
    const walletLink = await completeWalletChallenge(recoverySession, walletChallenge.challengeId, signature.signature);
    assert.equal(walletLink.address, recoveryKey.toSuiAddress().toLowerCase());
    await assert.rejects(
      completeWalletChallenge(recoverySession, walletChallenge.challengeId, signature.signature),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'wallet_challenge_expired'),
    );

    const agent: AgentPrincipal = {
      id: agentId,
      ownerId,
      name: 'test agent',
      scopes: ['search_workers', 'create_task', 'get_task', 'request_hire', 'review_submission', 'request_release'],
      categories: ['home'],
      maxTaskAtomic: '100',
      totalBudgetAtomic: '100',
    };
    const otherAgent: AgentPrincipal = {
      id: otherAgentId,
      ownerId,
      name: 'other test agent',
      scopes: ['search_workers', 'create_task', 'get_task', 'request_hire', 'review_submission', 'request_release'],
      categories: ['home'],
      maxTaskAtomic: '100',
      totalBudgetAtomic: '100',
    };
    const makeTask = (amountAtomic: string) => ({
      title: 'Isolated budget test',
      brief: 'Use the disposable test schema only.',
      category: 'home',
      area: 'test area',
      rubric: ['Complete the test task'],
      amountAtomic,
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const postingBalance = {
      readBalance: async () => ({ balance: { balance: '100' } }),
    };

    const competingCreates = await Promise.allSettled([
      createTaskForAgent(agent, makeTask('70'), undefined, postingBalance),
      createTaskForAgent(otherAgent, makeTask('70'), undefined, postingBalance),
    ]);
    const created = competingCreates.filter((result) => result.status === 'fulfilled');
    assert.equal(created.length, 1, 'one concurrent task creation should reserve the remaining budget');
    const openTaskId = created[0].status === 'fulfilled' ? created[0].value.id : '';
    assert.ok(openTaskId);
    const [budgetAfterRace] = await isolated`SELECT COALESCE(SUM(reserved_atomic), 0) AS reserved_atomic FROM agents WHERE owner_id = ${ownerId}`;
    assert.equal(String(budgetAfterRace.reserved_atomic), '70');
    const secondTask = await createTaskForAgent(agent, makeTask('30'), undefined, postingBalance);
    const winningAgentId = created[0].status === 'fulfilled' ? created[0].value.agentId : '';
    const winningAgent = winningAgentId === otherAgent.id ? otherAgent : agent;
    await assert.rejects(
      createTaskForAgent(winningAgent, makeTask('31'), undefined, postingBalance),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'agent_policy_rejected'),
    );
    await isolated`
      INSERT INTO task_applications (id, task_id, worker_id, status)
      VALUES (${randomUUID()}, ${openTaskId}, ${workerIds[0]}, 'APPLIED'),
             (${randomUUID()}, ${openTaskId}, ${workerIds[1]}, 'APPLIED')
    `;
    const ownerSession: Session = {
      id: randomUUID(), rawToken: 'test-only-owner-session', csrfToken: 'test-only-csrf',
      workerId: null, ownerId, expiresAt: new Date(Date.now() + 60_000),
    };
    const selected = await ownerSelectWorker(ownerSession, openTaskId, workerIds[0]);
    assert.equal(selected.status, 'SELECTED');
    await assert.rejects(
      ownerSelectWorker(ownerSession, openTaskId, workerIds[1]),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'task_selection_locked'),
    );
    const [assignment] = await isolated`SELECT assigned_worker_id, state FROM tasks WHERE id = ${openTaskId}`;
    assert.equal(assignment.state, 'ASSIGNED');
    assert.ok(workerIds.includes(assignment.assigned_worker_id));

    const anonymousState = await getBrowserState({
      id: randomUUID(), rawToken: 'anonymous-test-session', csrfToken: 'test-only-csrf',
      workerId: null, ownerId: null, expiresAt: new Date(Date.now() + 60_000),
    });
    const anonymousOpenTask = anonymousState.tasks.find((task) => task.id === secondTask.id);
    assert.ok(anonymousOpenTask);
    assert.equal('brief' in anonymousOpenTask, false, 'anonymous open task state must omit the private brief');
    assert.equal('rubric' in anonymousOpenTask, false, 'anonymous open task state must omit the private rubric');

    const state = await getBrowserState({
      id: randomUUID(), rawToken: 'test-only-session', csrfToken: 'test-only-csrf',
      workerId: assignment.assigned_worker_id, ownerId, expiresAt: new Date(Date.now() + 60_000),
    });
    const serializedState = JSON.stringify(state);
    for (const privateValue of [...privateNullifiers, oidcSubjectFixture, 'f'.repeat(64)]) {
      assert.equal(serializedState.includes(privateValue), false, 'private identity and credential data must not appear in browser state');
    }
    assert.ok(state.tasks.some((task) => task.id === secondTask.id));
  } catch (error) {
    // Keep useful policy assertions while suppressing raw driver diagnostics that may include deployment details.
    if (error instanceof Error && ['AssertionError', 'HttpError'].includes(error.name)) throw error;
    throw new Error('Isolated PostgreSQL marketplace integration test failed.');
  } finally {
    try {
      await closeDbForTests();
      if (isolated) await isolated.end({ timeout: 1 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    } finally {
      await admin.end({ timeout: 1 });
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalAskDatabaseUrl === undefined) delete process.env.ASK2HUMAN_DATABASE_URL;
      else process.env.ASK2HUMAN_DATABASE_URL = originalAskDatabaseUrl;
      if (originalAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = originalAppUrl;
      if (originalWorldEnvironment === undefined) delete process.env.WORLD_ID_ENVIRONMENT;
      else process.env.WORLD_ID_ENVIRONMENT = originalWorldEnvironment;
      if (originalWorkerAction === undefined) delete process.env.WORLD_ID_WORKER_ACTION;
      else process.env.WORLD_ID_WORKER_ACTION = originalWorkerAction;
    }
  }
});
