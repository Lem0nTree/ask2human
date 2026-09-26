import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { closeDbForTests } from '../app/lib/server/db';
import { T2000_COIN_TYPE, T2000_DEFAULT_PACKAGE_ID } from '../app/lib/sui/t2000';
import type { Session } from '../app/lib/server/session';

try {
  process.loadEnvFile('.env');
} catch {
  // The database check is skipped unless an explicit test database or a
  // loopback DATABASE_URL is available.
}

const migrationPath = resolve('infra/migrations/005_t2000_release_attempt_columns.sql');
const explicitTestDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

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

const databaseUrl = explicitTestDatabaseUrl || (isLoopbackPostgresUrl(process.env.DATABASE_URL) ? process.env.DATABASE_URL : undefined);
const databaseSkipReason = databaseUrl
  ? false
  : 'Set TEST_DATABASE_URL or use a loopback DATABASE_URL for this isolated migration check.';

const serverOnlyLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20%7B%7D', shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);

test('005 declares every release freeze column as an idempotent additive repair', async () => {
  const source = await readFile(migrationPath, 'utf8');
  for (const column of ['release_transaction_json', 'release_transaction_bytes_base64', 'release_expected_digest']) {
    assert.match(source, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
  }
  assert.match(source, /CREATE INDEX IF NOT EXISTS settlements_release_expected_digest_idx/);
  assert.doesNotMatch(source, /DROP COLUMN|RENAME COLUMN|ALTER COLUMN .* TYPE/);
});

test('release builder reuses an issued attempt on a freshly migrated schema', { skip: databaseSkipReason }, async () => {
  const schema = `ask2human_m005_${randomUUID().replaceAll('-', '')}`;
  const previous = {
    databaseUrl: process.env.DATABASE_URL,
    askDatabaseUrl: process.env.ASK2HUMAN_DATABASE_URL,
    network: process.env.SUI_NETWORK,
    rpcUrl: process.env.SUI_RPC_URL,
    packageId: process.env.T2000_ESCROW_PACKAGE_ID,
  };
  const admin = postgres(databaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let scoped: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.ASK2HUMAN_DATABASE_URL = scopedUrl.toString();
    process.env.SUI_NETWORK = 'mainnet';
    process.env.SUI_RPC_URL = 'http://127.0.0.1:1';
    process.env.T2000_ESCROW_PACKAGE_ID = T2000_DEFAULT_PACKAGE_ID;
    scoped = postgres(scopedUrl.toString(), { max: 4, idle_timeout: 2, connect_timeout: 8, prepare: false, onnotice: () => {} });

    const migrationFiles = (await readdir(resolve('infra/migrations')))
      .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();
    for (const file of migrationFiles) {
      const source = await readFile(resolve('infra/migrations', file), 'utf8');
      await scoped.unsafe(source, [], { prepare: false });
    }

    // Applying the corrective file again must remain harmless for retrying a
    // deployment whose migration marker was written before a crash.
    await scoped.unsafe(await readFile(migrationPath, 'utf8'), [], { prepare: false });

    const ownerId = randomUUID();
    const agentId = randomUUID();
    const workerId = randomUUID();
    const taskId = randomUUID();
    const ownerWallet = `0x${'11'.repeat(32)}`;
    const workerWallet = `0x${'22'.repeat(32)}`;
    const jobId = `0x${'33'.repeat(32)}`;
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    await scoped`
      INSERT INTO owners (id, oidc_issuer, oidc_subject, wallet_address, wallet_verified_at)
      VALUES (${ownerId}, 'https://test.invalid', ${`owner-${ownerId}`}, ${ownerWallet}, now())
    `;
    await scoped`
      INSERT INTO agents (id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic)
      VALUES (${agentId}, ${ownerId}, 'migration checker', ${'a'.repeat(64)},
        ${scoped.array(['review_submission'])}, ${scoped.array(['home'])}, 100000, 100000)
    `;
    await scoped`
      INSERT INTO workers (id, display_name, category, area, status, wallet_address, wallet_verified_at, idkit_nullifier, idkit_verified_at)
      VALUES (${workerId}, 'migration checker', 'home', 'test area', 'VERIFIED', ${workerWallet}, now(), ${`nullifier-${workerId}`}, now())
    `;
    await scoped`
      INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline,
        state, assigned_worker_id, job_id, review_decision, asset, network, decimals, legacy_read_only,
        review_window_ms, reject_split_bps)
      VALUES (${taskId}, ${ownerId}, ${agentId}, 'Release schema check', 'Private release schema check', 'home', 'test area', '[]'::jsonb,
        20000, ${deadline}, 'SUBMITTED', ${workerId}, ${jobId}, 'ACCEPT', 'USDC', 'mainnet', 6, false, 300000, 5000)
    `;
    await scoped`
      INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
        brief_hash, deadline, job_id, status, asset, decimals, review_window_ms, reject_split_bps)
      VALUES (${taskId}, 'mainnet', ${T2000_DEFAULT_PACKAGE_ID}, ${T2000_COIN_TYPE}, 20000, ${ownerWallet}, ${workerWallet},
        ${`0x${'44'.repeat(32)}`}, ${deadline}, ${jobId}, 'SUBMITTED', 'USDC', 6, 300000, 5000)
    `;
    await scoped`
      INSERT INTO approvals (id, task_id, owner_id, agent_id, kind, status, amount_atomic, worker_id, worker_wallet,
        owner_wallet, expires_at, consented_at, transaction_bytes_base64, expected_digest, asset, network, decimals,
        review_window_ms, reject_split_bps)
      VALUES (${randomUUID()}, ${taskId}, ${ownerId}, ${agentId}, 'RELEASE', 'ISSUED', 20000, ${workerId}, ${workerWallet},
        ${ownerWallet}, ${deadline}, now(), 'release-bytes', 'release-digest', 'USDC', 'mainnet', 6, 300000, 5000)
    `;

    const { buildReleaseTransaction } = await import('../app/lib/server/payments');
    const session: Session = {
      id: randomUUID(), rawToken: 'migration-test-session', csrfToken: 'migration-test-csrf',
      ownerId, workerId: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const result = await buildReleaseTransaction(session, taskId);
    assert.equal(result.transactionBytesBase64, 'release-bytes');
    assert.equal(result.expectedDigest, 'release-digest');

    const [columns] = await scoped`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'settlements'
        AND column_name IN ('release_transaction_json', 'release_transaction_bytes_base64', 'release_expected_digest')
    `;
    assert.equal(columns.count, 3);
  } finally {
    await closeDbForTests();
    if (scoped) await scoped.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 1 });
    for (const [key, value] of [
      ['DATABASE_URL', previous.databaseUrl],
      ['ASK2HUMAN_DATABASE_URL', previous.askDatabaseUrl],
      ['SUI_NETWORK', previous.network],
      ['SUI_RPC_URL', previous.rpcUrl],
      ['T2000_ESCROW_PACKAGE_ID', previous.packageId],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
