import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { resolve } from 'node:path';
import postgres from 'postgres';
import test from 'node:test';
import { closeDbForTests } from '../app/lib/server/db';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const serverOnlyLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);
const { getExperienceTask, listPublicTasks, publicOwnerHandle } = await import('../app/lib/server/experience');

test('owner handles are stable UUID pseudonyms with no identity input', () => {
  const ownerId = randomUUID();
  const equivalentOwnerId = ownerId.toUpperCase();
  const otherOwnerId = randomUUID();

  assert.equal(publicOwnerHandle(ownerId), publicOwnerHandle(equivalentOwnerId));
  assert.match(publicOwnerHandle(ownerId), /^[0-9A-F]{12}$/);
  assert.notEqual(publicOwnerHandle(ownerId), publicOwnerHandle(otherOwnerId));
});

test('public publisher history spans agents and includes only confirmed positive seller receipts', { skip: !testDatabaseUrl }, async () => {
  const schema = `ask2human_reputation_test_${randomUUID().replaceAll('-', '')}`;
  const priorAppUrl = process.env.APP_URL;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const priorAskDatabaseUrl = process.env.ASK2HUMAN_DATABASE_URL;
  const admin = postgres(testDatabaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let scoped: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(testDatabaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.ASK2HUMAN_DATABASE_URL = scopedUrl.toString();
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.APP_URL = 'https://test.invalid';
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

    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const agentOneId = randomUUID();
    const agentTwoId = randomUUID();
    const otherAgentId = randomUUID();
    const workerId = randomUUID();
    const canonicalUsdc = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    await scoped`
      INSERT INTO owners (id, oidc_issuer, oidc_subject)
      VALUES (${ownerId}, 'https://test.invalid', ${`owner-${ownerId}`}),
             (${otherOwnerId}, 'https://test.invalid', ${`owner-${otherOwnerId}`})
    `;
    const scopes = scoped.array(['search_workers', 'create_task', 'get_task']);
    const categories = scoped.array(['home']);
    await scoped`
      INSERT INTO agents (id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic)
      VALUES (${agentOneId}, ${ownerId}, 'Atlas Alpha', ${'a'.repeat(64)}, ${scopes}, ${categories}, 100000000, 100000000),
             (${agentTwoId}, ${ownerId}, 'Atlas Beta', ${'b'.repeat(64)}, ${scopes}, ${categories}, 100000000, 100000000),
             (${otherAgentId}, ${otherOwnerId}, 'Other Agent', ${'c'.repeat(64)}, ${scopes}, ${categories}, 100000000, 100000000)
    `;
    await scoped`
      INSERT INTO workers (id, display_name, category, area)
      VALUES (${workerId}, 'Test worker', 'home', 'test area')
    `;

    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    const addTask = async (input: { owner: string; agent: string; state: string; title: string }) => {
      const id = randomUUID();
      await scoped!`
        INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline,
          state, assigned_worker_id, asset, network, decimals, legacy_read_only, review_window_ms, reject_split_bps)
        VALUES (${id}, ${input.owner}, ${input.agent}, ${input.title}, 'Public reputation test brief', 'home', 'test area',
          ${scoped!.json(['Complete the task'])}, 1000000, ${deadline}, ${input.state}, ${input.state === 'OPEN' ? null : workerId},
          'USDC', 'mainnet', 6, false, 60000, 5000)
      `;
      return id;
    };
    const addSettlement = async (taskId: string, input: {
      status: string;
      asset?: string;
      network?: string;
      decimals?: number;
      netAtomic: number;
      settled?: boolean;
      releaseDigest?: string | null;
      rejectionDigest?: string | null;
    }) => {
      const asset = input.asset ?? 'USDC';
      const network = input.network ?? 'mainnet';
      const decimals = input.decimals ?? 6;
      await scoped!`
        INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
          brief_hash, deadline, status, asset, decimals, fee_atomic, net_atomic, settled_at, release_digest, rejection_digest)
        VALUES (${taskId}, ${network}, '0xpackage', ${asset === 'USDC' ? canonicalUsdc : '0x2::sui::SUI'}, 1000000,
          '0xowner', '0xworker', ${'d'.repeat(64)}, ${deadline}, ${input.status}, ${asset}, ${decimals}, 0,
          ${input.netAtomic}, ${input.settled === false ? null : new Date()}, ${input.releaseDigest ?? null}, ${input.rejectionDigest ?? null})
      `;
    };

    const openTask = await addTask({ owner: ownerId, agent: agentOneId, state: 'OPEN', title: 'public reputation open task' });
    const paidTaskOne = await addTask({ owner: ownerId, agent: agentOneId, state: 'PAID', title: 'public reputation paid one' });
    const paidTaskTwo = await addTask({ owner: ownerId, agent: agentTwoId, state: 'PAID', title: 'public reputation paid two' });
    const rejectedTask = await addTask({ owner: ownerId, agent: agentTwoId, state: 'REJECTED', title: 'public reputation rejected partial' });
    const pendingTask = await addTask({ owner: ownerId, agent: agentOneId, state: 'FUNDED', title: 'public reputation pending' });
    const refundedTask = await addTask({ owner: ownerId, agent: agentTwoId, state: 'REFUNDED', title: 'public reputation refunded' });
    const legacyTask = await addTask({ owner: ownerId, agent: agentTwoId, state: 'PAID', title: 'public reputation legacy' });
    const missingReceiptTask = await addTask({ owner: ownerId, agent: agentOneId, state: 'PAID', title: 'public reputation missing receipt' });
    const zeroNetTask = await addTask({ owner: ownerId, agent: agentTwoId, state: 'PAID', title: 'public reputation zero net' });
    const otherOwnerTask = await addTask({ owner: otherOwnerId, agent: otherAgentId, state: 'PAID', title: 'other owner paid task' });

    await addSettlement(paidTaskOne, { status: 'PAID', netAtomic: 1000001, releaseDigest: 'release-one' });
    await addSettlement(paidTaskTwo, { status: 'PAID', netAtomic: 2000002, releaseDigest: 'release-two' });
    await addSettlement(rejectedTask, { status: 'REJECTED', netAtomic: 333333, rejectionDigest: 'reject-partial' });
    await addSettlement(pendingTask, { status: 'FUNDED', netAtomic: 999999, settled: false });
    await addSettlement(refundedTask, { status: 'REFUNDED', netAtomic: 888888 });
    await scoped!`UPDATE tasks SET asset = 'SUI', network = 'testnet', decimals = 9, legacy_read_only = true WHERE id = ${legacyTask}`;
    await addSettlement(legacyTask, { status: 'PAID', asset: 'SUI', network: 'testnet', decimals: 9, netAtomic: 777777, releaseDigest: 'legacy-release' });
    await addSettlement(missingReceiptTask, { status: 'PAID', netAtomic: 666666 });
    await addSettlement(zeroNetTask, { status: 'PAID', netAtomic: 0, releaseDigest: 'zero-release' });
    await addSettlement(otherOwnerTask, { status: 'PAID', netAtomic: 4000000, releaseDigest: 'other-release' });
    for (let index = 0; index < 101; index += 1) {
      const historyTask = await addTask({ owner: ownerId, agent: agentTwoId, state: 'PAID', title: `public reputation history ${index}` });
      await addSettlement(historyTask, { status: 'PAID', netAtomic: 1, releaseDigest: `history-release-${index}` });
    }

    const listed = await listPublicTasks({ status: 'open', query: 'public reputation open' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].agentName, 'Atlas Alpha');
    assert.equal('publisher' in listed[0], false, 'owner history belongs on task details, not list rows');

    const openDetail = await getExperienceTask(openTask, null);
    assert.deepEqual(openDetail.publisher, {
      agentName: 'Atlas Alpha',
      ownerHandle: publicOwnerHandle(ownerId),
      paidTaskCount: 104,
      totalPaidAtomic: '3333437',
    });
    const completedRows = await listPublicTasks({ status: 'completed', query: 'public reputation history' });
    assert.equal(completedRows.length, 100, 'the public task feed remains capped independently of owner history');
    const secondAgentDetail = await getExperienceTask(paidTaskTwo, null);
    assert.equal(secondAgentDetail.publisher.agentName, 'Atlas Beta');
    assert.equal(secondAgentDetail.publisher.ownerHandle, openDetail.publisher.ownerHandle);
    assert.equal(secondAgentDetail.publisher.paidTaskCount, 104);
    assert.equal(secondAgentDetail.publisher.totalPaidAtomic, '3333437');

    const otherOwnerDetail = await getExperienceTask(otherOwnerTask, null);
    assert.equal(otherOwnerDetail.publisher.agentName, 'Other Agent');
    assert.notEqual(otherOwnerDetail.publisher.ownerHandle, openDetail.publisher.ownerHandle);
    assert.equal(otherOwnerDetail.publisher.paidTaskCount, 1);
    assert.equal(otherOwnerDetail.publisher.totalPaidAtomic, '4000000');
  } finally {
    try {
      await closeDbForTests();
      if (scoped) await scoped.end({ timeout: 1 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end({ timeout: 1 });
      if (priorAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = priorAppUrl;
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorAskDatabaseUrl === undefined) delete process.env.ASK2HUMAN_DATABASE_URL;
      else process.env.ASK2HUMAN_DATABASE_URL = priorAskDatabaseUrl;
    }
  }
});
