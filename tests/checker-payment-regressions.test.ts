import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { closeDbForTests } from '../app/lib/server/db';
import type { AgentPrincipal } from '../app/lib/server/marketplace';
import type { Session } from '../app/lib/server/session';
import { T2000_COIN_TYPE, T2000_DEFAULT_PACKAGE_ID } from '../app/lib/sui/t2000';

try {
  process.loadEnvFile('.env');
} catch {
  // A local database is optional outside the development workspace.
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
const serverOnlyLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20%7B%7D', shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);

type Fixture = {
  sql: ReturnType<typeof postgres>;
  ownerId: string;
  agentId: string;
  workerId: string;
  taskId: string;
  ownerWallet: string;
  workerWallet: string;
  session: Session;
  agent: AgentPrincipal;
};

async function withIsolatedFixture(run: (fixture: Fixture) => Promise<void>) {
  const schema = `groundwork_checker_${randomUUID().replaceAll('-', '')}`;
  const original = {
    databaseUrl: process.env.DATABASE_URL,
    askDatabaseUrl: process.env.ASK2HUMAN_DATABASE_URL,
    packageId: process.env.SUI_ESCROW_PACKAGE_ID,
    rpcUrl: process.env.SUI_RPC_URL,
    network: process.env.SUI_NETWORK,
    t2000Package: process.env.T2000_ESCROW_PACKAGE_ID,
    t2000CoinType: process.env.T2000_COIN_TYPE,
  };
  const admin = postgres(databaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let isolated: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const schemaUrl = new URL(databaseUrl!);
    // Exercise a valid PostgreSQL plan that does not happen to read the
    // approvals index newest-first; SQL without ORDER BY must tolerate it.
    schemaUrl.searchParams.set('options', `-c search_path=${schema} -c enable_indexscan=off -c enable_bitmapscan=off`);
    process.env.DATABASE_URL = schemaUrl.toString();
    process.env.ASK2HUMAN_DATABASE_URL = schemaUrl.toString();
    process.env.SUI_ESCROW_PACKAGE_ID = `0x${'a'.repeat(64)}`;
    process.env.SUI_RPC_URL = 'https://test.invalid';
    process.env.SUI_NETWORK = 'mainnet';
    process.env.T2000_ESCROW_PACKAGE_ID = T2000_DEFAULT_PACKAGE_ID;
    process.env.T2000_COIN_TYPE = T2000_COIN_TYPE;
    isolated = postgres(process.env.DATABASE_URL, { max: 6, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
    const files = (await readdir(resolve('infra/migrations')))
      .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file)).sort();
    for (const file of files) {
      const source = await readFile(resolve('infra/migrations', file), 'utf8');
      await isolated.unsafe(source, [], { prepare: false });
    }

    const ownerId = randomUUID();
    const agentId = randomUUID();
    const workerId = randomUUID();
    const taskId = randomUUID();
    const ownerWallet = `0x${'11'.repeat(32)}`;
    const workerWallet = `0x${'22'.repeat(32)}`;
    await isolated`
      INSERT INTO owners (id, oidc_issuer, oidc_subject, wallet_address, wallet_verified_at)
      VALUES (${ownerId}, 'https://test.invalid', ${`checker-${ownerId}`}, ${ownerWallet}, now())
    `;
    await isolated`
      INSERT INTO agents (id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic, reserved_atomic)
      VALUES (${agentId}, ${ownerId}, 'checker agent', ${'f'.repeat(64)},
        ${isolated.array(['review_submission'])}, ${isolated.array(['home'])}, 100, 100, 40)
    `;
    await isolated`
      INSERT INTO workers (id, display_name, category, area, status, wallet_address, wallet_verified_at, idkit_nullifier, idkit_verified_at)
      VALUES (${workerId}, 'checker worker', 'home', 'test area', 'VERIFIED', ${workerWallet}, now(), ${`0x${'33'.repeat(32)}`}, now())
    `;
    const session: Session = {
      id: randomUUID(), rawToken: 'checker-session', csrfToken: 'checker-csrf',
      workerId: null, ownerId, expiresAt: new Date(Date.now() + 60_000),
    };
    const agent: AgentPrincipal = {
      id: agentId, ownerId, name: 'checker agent', scopes: ['review_submission'], categories: ['home'],
      maxTaskAtomic: '100', totalBudgetAtomic: '100',
    };
    await run({ sql: isolated, ownerId, agentId, workerId, taskId, ownerWallet, workerWallet, session, agent });
  } finally {
    await closeDbForTests();
    if (isolated) await isolated.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 1 });
    for (const [key, oldValue] of [
      ['DATABASE_URL', original.databaseUrl],
      ['ASK2HUMAN_DATABASE_URL', original.askDatabaseUrl],
      ['SUI_ESCROW_PACKAGE_ID', original.packageId],
      ['SUI_RPC_URL', original.rpcUrl],
      ['SUI_NETWORK', original.network],
      ['T2000_ESCROW_PACKAGE_ID', original.t2000Package],
      ['T2000_COIN_TYPE', original.t2000CoinType],
    ] as const) {
      if (oldValue === undefined) delete process.env[key];
      else process.env[key] = oldValue;
    }
  }
}

test('refund recovery keeps an owner score checkpoint separate from a worker score attempt', { skip: databaseSkipReason }, async () => {
  await withIsolatedFixture(async ({ sql }) => {
    const rows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'settlements'
        AND column_name = ANY(${sql.array([
          'score_transaction_bytes_base64',
          'score_expected_digest',
          'score_ready_at',
          'score_sender',
          'refund_score_transaction_bytes_base64',
          'refund_score_expected_digest',
          'refund_score_digest',
          'refund_score_sender',
        ])})
      ORDER BY column_name
    `;
    assert.deepEqual(rows.map((row) => row.column_name), [
      'refund_score_digest',
      'refund_score_expected_digest',
      'refund_score_sender',
      'refund_score_transaction_bytes_base64',
      'score_expected_digest',
      'score_ready_at',
      'score_sender',
      'score_transaction_bytes_base64',
    ]);
  });
});

test('funding retry reads the issued approval when an older hire approval exists', { skip: databaseSkipReason }, async () => {
  await withIsolatedFixture(async ({ sql, ownerId, agentId, workerId, taskId, ownerWallet, workerWallet, session }) => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline, state, assigned_worker_id)
      VALUES (${taskId}, ${ownerId}, ${agentId}, 'Checker task', 'Evidence', 'home', 'test area', '[]'::jsonb, 40, ${deadline}, 'FUNDING', ${workerId})
    `;
    await sql`
      INSERT INTO approvals (id, task_id, owner_id, agent_id, kind, status, amount_atomic, worker_id, worker_wallet, owner_wallet, expires_at)
      VALUES (${randomUUID()}, ${taskId}, ${ownerId}, ${agentId}, 'HIRE', 'DENIED', 40, ${workerId}, ${workerWallet}, ${ownerWallet}, ${new Date(Date.now() - 60_000)})
    `;
    const issuedId = randomUUID();
    await sql`
      INSERT INTO approvals (id, task_id, owner_id, agent_id, kind, status, amount_atomic, worker_id, worker_wallet, owner_wallet, expires_at, transaction_bytes_base64, expected_digest)
      VALUES (${issuedId}, ${taskId}, ${ownerId}, ${agentId}, 'HIRE', 'ISSUED', 40, ${workerId}, ${workerWallet}, ${ownerWallet}, ${deadline}, 'checker-frozen-bytes', 'checker-frozen-digest')
    `;
    await sql`
      INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet, brief_hash, deadline, review_window_ms, reject_split_bps, status, funding_transaction_bytes_base64, funding_expected_digest)
      VALUES (${taskId}, 'mainnet', ${T2000_DEFAULT_PACKAGE_ID}, ${T2000_COIN_TYPE}, 40, ${ownerWallet}, ${workerWallet}, ${`0x${'44'.repeat(32)}`}, ${deadline}, 300000, 5000, 'FUNDING', 'checker-frozen-bytes', 'checker-frozen-digest')
    `;
    const { buildFundingTransaction } = await import('../app/lib/server/payments');
    const result = await buildFundingTransaction(session, taskId);
    assert.equal(result.transactionBytesBase64, 'checker-frozen-bytes');
    assert.equal(result.expectedDigest, 'checker-frozen-digest');
  });
});

test('agent and owner reviews cannot be changed after release bytes are issued', { skip: databaseSkipReason }, async () => {
  await withIsolatedFixture(async ({ sql, ownerId, agentId, workerId, taskId, ownerWallet, workerWallet, session, agent }) => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline, state, assigned_worker_id, job_id, review_decision)
      VALUES (${taskId}, ${ownerId}, ${agentId}, 'Checker task', 'Evidence', 'home', 'test area', '[]'::jsonb, 40, ${deadline}, 'SUBMITTED', ${workerId}, ${`0x${'55'.repeat(32)}`}, 'ACCEPT')
    `;
    await sql`
      INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet, brief_hash, deadline, review_window_ms, reject_split_bps, status, job_id)
      VALUES (${taskId}, 'mainnet', ${T2000_DEFAULT_PACKAGE_ID}, ${T2000_COIN_TYPE}, 40, ${ownerWallet}, ${workerWallet}, ${`0x${'44'.repeat(32)}`}, ${deadline}, 300000, 5000, 'SUBMITTED', ${`0x${'55'.repeat(32)}`})
    `;
    await sql`
      INSERT INTO approvals (id, task_id, owner_id, agent_id, kind, status, amount_atomic, worker_id, worker_wallet, owner_wallet, expires_at, transaction_bytes_base64, expected_digest)
      VALUES (${randomUUID()}, ${taskId}, ${ownerId}, ${agentId}, 'RELEASE', 'ISSUED', 40, ${workerId}, ${workerWallet}, ${ownerWallet}, ${deadline}, 'checker-release-bytes', 'checker-release-digest')
    `;
    const { reviewSubmission, resolveReview } = await import('../app/lib/server/marketplace');
    await assert.rejects(
      reviewSubmission(agent, { taskId, decision: 'request_review' }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'release_already_issued'),
    );
    await assert.rejects(
      resolveReview(session, taskId, 'request_review'),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'release_already_issued'),
    );
    const [task] = await sql`SELECT state, review_decision FROM tasks WHERE id = ${taskId}`;
    assert.equal(task.state, 'SUBMITTED');
    assert.equal(task.review_decision, 'ACCEPT');
  });
});
