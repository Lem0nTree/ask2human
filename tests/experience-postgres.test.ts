import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { closeDbForTests } from '../app/lib/server/db';
import type { Session } from '../app/lib/server/session';

// Deliberately do not read DATABASE_URL or .env: this suite runs only when a
// separate, disposable integration-test database is explicitly provided.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('experience PostgreSQL selection, privacy, review timing, earnings, and confirmed ratings', { skip: !testDatabaseUrl }, async (t) => {
  const schema = `ask2human_test_${randomUUID().replaceAll('-', '')}`;
  const priorAppUrl = process.env.APP_URL;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const priorAskDatabaseUrl = process.env.ASK2HUMAN_DATABASE_URL;
  const priorWorldEnvironment = process.env.WORLD_ID_ENVIRONMENT;
  const priorWorkerAction = process.env.WORLD_ID_WORKER_ACTION;
  const admin = postgres(testDatabaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let scoped: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(testDatabaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.ASK2HUMAN_DATABASE_URL = scopedUrl.toString();
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.APP_URL = 'https://test.invalid';
    process.env.WORLD_ID_ENVIRONMENT = 'production';
    process.env.WORLD_ID_WORKER_ACTION = 'test-worker-enrollment';
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

    const serverOnlyLoader = `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `;
    register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);
    const { getExperienceTask, getWorkerDashboard, getWorkerProfile, ownerSelectWorker } = await import('../app/lib/server/experience');
    const { uploadEvidence } = await import('../app/lib/server/evidence');

    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const workerIds = [randomUUID(), randomUUID(), randomUUID()];
    const wallet = (hex: string) => `0x${hex.repeat(32)}`;
    const workerWallets = [wallet('1'), wallet('2'), wallet('3')];
    await scoped`
      INSERT INTO owners (id, oidc_issuer, oidc_subject)
      VALUES (${ownerId}, 'https://test.invalid', ${`owner-${ownerId}`}),
             (${otherOwnerId}, 'https://test.invalid', ${`owner-${otherOwnerId}`})
    `;
    const scopes = scoped.array(['search_workers', 'create_task', 'get_task', 'request_hire', 'review_submission', 'request_release', 'list_applicants', 'select_worker']);
    const categories = scoped.array(['home']);
    await scoped`
      INSERT INTO agents (id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic)
      VALUES (${agentId}, ${ownerId}, 'test agent', ${'a'.repeat(64)}, ${scopes}, ${categories}, 100000000, 100000000),
             (${otherAgentId}, ${otherOwnerId}, 'other agent', ${'b'.repeat(64)}, ${scopes}, ${categories}, 100000000, 100000000)
    `;
    for (let index = 0; index < workerIds.length; index += 1) {
      await scoped`
        INSERT INTO workers (id, display_name, category, area, status, wallet_address, wallet_verified_at,
          idkit_nullifier, idkit_verified_at, idkit_verified_environment, idkit_credential,
          idkit_credential_schema, idkit_sybil_score, idkit_action)
        VALUES (${workerIds[index]}, ${`worker ${index + 1}`}, 'home', 'test area', 'VERIFIED', ${workerWallets[index]}, now(),
          ${`nullifier-${workerIds[index]}`}, now(), 'production', 'selfie', 11, 7, 'test-worker-enrollment')
      `;
    }

    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    const addTask = async (input: { id?: string; owner?: string; agent?: string; state?: string; worker?: string | null; title?: string; reviewWindowMs?: number; amountAtomic?: number }) => {
      const id = input.id ?? randomUUID();
      await scoped!`
        INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline,
          state, assigned_worker_id, asset, network, decimals, legacy_read_only, review_window_ms, reject_split_bps)
        VALUES (${id}, ${input.owner ?? ownerId}, ${input.agent ?? agentId}, ${input.title ?? 'Test task'},
          'Private brief for integration testing', 'home', 'test area', ${scoped!.json(['Complete the task'])},
          ${input.amountAtomic ?? 1000}, ${deadline}, ${input.state ?? 'OPEN'}, ${input.worker ?? null}, 'USDC', 'mainnet', 6, false,
          ${input.reviewWindowMs ?? 60000}, 5000)
      `;
      return id;
    };
    const session = (owner: string | null, worker: string | null): Session => ({
      id: randomUUID(), rawToken: 'test-only-session', csrfToken: 'test-only-csrf',
      ownerId: owner, workerId: worker, expiresAt: new Date(Date.now() + 60_000),
    });

    const selectionTask = await addTask({});
    const privateTask = await addTask({ state: 'SUBMITTED', worker: workerIds[0], title: 'Private delivery test' });
    await scoped`
      INSERT INTO task_applications (id, task_id, worker_id, note, status)
      VALUES (${randomUUID()}, ${selectionTask}, ${workerIds[0]}, 'worker one', 'APPLIED'),
             (${randomUUID()}, ${selectionTask}, ${workerIds[1]}, 'worker two', 'APPLIED')
    `;
    await scoped`
      INSERT INTO evidence (id, task_id, worker_id, object_key, media_type, byte_length, sha256, report, commitment_hash)
      VALUES (${randomUUID()}, ${privateTask}, ${workerIds[0]}, ${`private/${privateTask}`}, 'image/jpeg', 42,
        ${'c'.repeat(64)}, 'Private delivery report', ${'d'.repeat(64)})
    `;

    await t.test('a different owner cannot select from this task', async () => {
      await assert.rejects(ownerSelectWorker(session(otherOwnerId, null), selectionTask, workerIds[0]), (error: unknown) =>
        error instanceof Error && 'status' in error && error.status === 404 &&
        'code' in error && error.code === 'task_not_found');
      const [task] = await scoped!`SELECT state, assigned_worker_id FROM tasks WHERE id = ${selectionTask}`;
      assert.equal(task.state, 'OPEN');
      assert.equal(task.assigned_worker_id, null);
    });

    await t.test('concurrent owner choices commit one selected applicant', async () => {
      const outcomes = await Promise.allSettled([
        ownerSelectWorker(session(ownerId, null), selectionTask, workerIds[0]),
        ownerSelectWorker(session(ownerId, null), selectionTask, workerIds[1]),
      ]);
      const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      assert.equal(winners.length, 1);
      const [task] = await scoped!`SELECT state, assigned_worker_id FROM tasks WHERE id = ${selectionTask}`;
      assert.equal(task.state, 'ASSIGNED');
      assert.ok(workerIds.slice(0, 2).includes(task.assigned_worker_id));
      const applications = await scoped!`SELECT worker_id, status FROM task_applications WHERE task_id = ${selectionTask}`;
      assert.equal(applications.filter((application) => application.status === 'SELECTED').length, 1);
      assert.equal(applications.filter((application) => application.status === 'DECLINED').length, 1);
    });

    await t.test('private task evidence is visible only to its owner and selected worker', async () => {
      const ownerView = await getExperienceTask(privateTask, session(ownerId, null));
      const workerView = await getExperienceTask(privateTask, session(null, workerIds[0]));
      const unrelatedView = await getExperienceTask(privateTask, session(null, workerIds[2]));
      const anonymousView = await getExperienceTask(privateTask, null);
      assert.equal(ownerView.evidence?.report, 'Private delivery report');
      assert.equal(workerView.evidence?.report, 'Private delivery report');
      assert.equal(unrelatedView.evidence, null);
      assert.equal(anonymousView.evidence, null);
      assert.equal(unrelatedView.brief, null);
      assert.equal(anonymousView.brief, null);
    });

    await t.test('review window starts at escrow-reported delivery, not local confirmation time', async () => {
      const submittedTask = await addTask({ state: 'SUBMITTED', worker: workerIds[0], title: 'Review clock test', reviewWindowMs: 60_000 });
      const fundedOnlyTask = await addTask({ state: 'FUNDED', worker: workerIds[0], title: 'No submission clock test', reviewWindowMs: 60_000 });
      const fundingAt = new Date(Date.now() - 10 * 60_000);
      const localSubmissionAt = new Date(Date.now() - 30_000);
      const chainDeliveredAt = new Date(Date.now() - 2 * 60_000);
      await scoped!`UPDATE tasks SET delivered_at = ${fundingAt} WHERE id = ${submittedTask}`;
      await scoped!`
        INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
          brief_hash, deadline, status, asset, decimals, delivered_at, review_window_ms, reject_split_bps)
        VALUES (${submittedTask}, 'mainnet', '0xpackage', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
          1000, ${workerWallets[2]}, ${workerWallets[0]}, ${'d'.repeat(64)}, ${deadline}, 'SUBMITTED', 'USDC', 6,
          ${chainDeliveredAt}, 60000, 5000)
      `;
      await scoped!`
        INSERT INTO audit_events (actor_type, task_id, event_type, created_at)
        VALUES ('chain', ${submittedTask}, 'funding_confirmed', ${fundingAt}),
               ('chain', ${submittedTask}, 'submission_confirmed', ${localSubmissionAt}),
               ('chain', ${fundedOnlyTask}, 'funding_confirmed', ${fundingAt})
      `;
      const withSubmission = await getExperienceTask(submittedTask, session(ownerId, null));
      const withoutSubmission = await getExperienceTask(fundedOnlyTask, session(ownerId, null));
      assert.equal(withSubmission.deliveredAt, chainDeliveredAt.toISOString());
      assert.equal(withSubmission.reviewEndsAt, new Date(chainDeliveredAt.getTime() + 60_000).toISOString());
      assert.ok(new Date(withSubmission.reviewEndsAt!).getTime() < Date.now(), 'the claim window follows chain-reported delivery, even when local reconciliation is delayed');
      assert.equal(withoutSubmission.reviewEndsAt, null);
    });

    await t.test('funded task exposes exact quote and finalized fee/net before delivery', async () => {
      const fundedTask = await addTask({ state: 'FUNDED', worker: workerIds[0], title: 'Fee acknowledgement test', amountAtomic: 1003 });
      await scoped!`
        INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
          brief_hash, deadline, status, asset, decimals, fee_quote_bps, fee_quote_atomic, funding_fee_bps)
        VALUES (${fundedTask}, 'mainnet', '0xpackage', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
          1003, ${workerWallets[2]}, ${workerWallets[0]}, ${'9'.repeat(64)}, ${deadline}, 'FUNDED', 'USDC', 6, 200, 20, 375)
      `;
      const workerView = await getExperienceTask(fundedTask, session(null, workerIds[0]));
      assert.equal(workerView.settlement?.feeQuoteBps, 200);
      assert.equal(workerView.settlement?.feeQuoteAtomic, '20');
      assert.equal(workerView.settlement?.netQuoteAtomic, '983');
      assert.equal(workerView.settlement?.fundingFeeBps, 375);
      assert.equal(workerView.settlement?.fundingFeeAtomic, '37', 'fee uses integer floor rounding like the payment quote');
      assert.equal(workerView.settlement?.fundingNetAtomic, '966');
      assert.equal(workerView.settlement?.feeChanged, true);
      assert.equal(workerView.settlement?.feeAcknowledgedAt, null);
      assert.equal(workerView.settlement?.scoreReady, false);
      const form = new FormData();
      form.set('taskId', fundedTask);
      form.set('report', 'A valid report that must not be stored');
      form.set('file', new File([Uint8Array.from([0xff, 0xd8, 0xff])], 'tiny.jpg', { type: 'image/jpeg' }));
      const request = new Request('https://test.invalid/api/evidence', { method: 'POST', body: form });
      await assert.rejects(uploadEvidence(request, session(null, workerIds[0])), (error: unknown) =>
        error instanceof Error && 'status' in error && error.status === 409 &&
        'code' in error && error.code === 'fee_changed_acknowledgement_required');
      const acknowledgedAt = new Date();
      await scoped!`UPDATE settlements SET score_id = ${`0x${'f'.repeat(64)}`} WHERE task_id = ${fundedTask}`;
      const derivedButUnconfirmed = await getExperienceTask(fundedTask, session(null, workerIds[0]));
      assert.equal(derivedButUnconfirmed.settlement?.scoreReady, false, 'a deterministic score ID alone does not prove that the chain object exists');
      await scoped!`UPDATE settlements SET fee_acknowledged_at = ${acknowledgedAt}, score_ready_at = ${acknowledgedAt} WHERE task_id = ${fundedTask}`;
      const acknowledgedView = await getExperienceTask(fundedTask, session(null, workerIds[0]));
      assert.equal(acknowledgedView.settlement?.feeAcknowledgedAt, acknowledgedAt.toISOString());
      assert.equal(acknowledgedView.settlement?.scoreReady, true, 'the authoritative readiness marker survives a page reload');
    });

    await t.test('earnings include all confirmed seller fee plus net, exclude refunds, and ignore feed cap', async () => {
      const paidTaskIds: string[] = [];
      for (let index = 0; index < 103; index += 1) {
        paidTaskIds.push(await addTask({ state: 'PAID', worker: workerIds[0], title: `Paid task ${index}` }));
      }
      for (const [index, taskId] of paidTaskIds.entries()) {
        await scoped!`
          INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
            brief_hash, deadline, status, asset, decimals, fee_atomic, net_atomic, settled_at, release_digest)
          VALUES (${taskId}, 'mainnet', '0xpackage', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
            1000, ${workerWallets[2]}, ${workerWallets[0]}, ${'e'.repeat(64)}, ${deadline}, 'PAID', 'USDC', 6,
            10, 990, now() - interval '1 day', ${`0x${String(index + 1).padStart(64, '0')}`})
        `;
      }
      const rejectedTask = await addTask({ state: 'REJECTED', worker: workerIds[0], title: 'Partial rejection payout' });
      await scoped!`
        INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
          brief_hash, deadline, status, asset, decimals, fee_atomic, net_atomic, settled_at, rejection_digest)
        VALUES (${rejectedTask}, 'mainnet', '0xpackage', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
          1000, ${workerWallets[2]}, ${workerWallets[0]}, ${'f'.repeat(64)}, ${deadline}, 'REJECTED', 'USDC', 6,
          5, 400, now() - interval '1 day', ${`0x${'a'.repeat(64)}`})
      `;
      const refundedTask = await addTask({ state: 'REFUNDED', worker: workerIds[0], title: 'Refunded task' });
      await scoped!`
        INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
          brief_hash, deadline, status, asset, decimals, settled_at, refund_digest)
        VALUES (${refundedTask}, 'mainnet', '0xpackage', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
          1000, ${workerWallets[2]}, ${workerWallets[0]}, ${'1'.repeat(64)}, ${deadline}, 'REFUNDED', 'USDC', 6,
          now() - interval '1 day', ${`0x${'b'.repeat(64)}`})
      `;
      const pendingTask = await addTask({ state: 'FUNDED', worker: workerIds[0], title: 'Awaiting settlement' });
      await scoped!`
        INSERT INTO settlements (task_id, network, package_id, coin_type, amount_atomic, funder_wallet, worker_wallet,
          brief_hash, deadline, status, asset, decimals)
        VALUES (${pendingTask}, 'mainnet', '0xpackage', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
          700, ${workerWallets[2]}, ${workerWallets[0]}, ${'2'.repeat(64)}, ${deadline}, 'FUNDED', 'USDC', 6)
      `;

      const profileTasks = paidTaskIds.slice(0, 2);
      await scoped!`
        INSERT INTO ratings (task_id, reviewer_wallet, stars, digest, confirmed_at, network, coin_type)
        VALUES (${profileTasks[0]}, ${workerWallets[2]}, 4, ${`0x${'c'.repeat(63)}1`}, now(), 'mainnet', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'),
               (${profileTasks[1]}, ${workerWallets[2]}, 1, ${`0x${'c'.repeat(63)}2`}, NULL, 'mainnet', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')
      `;

      const dashboard = await getWorkerDashboard(session(null, workerIds[0]));
      assert.equal(dashboard.payments.length, 100, 'the visible payment feed remains capped');
      assert.equal(dashboard.totals.lifetimeGrossAtomic, '103405', 'all paid and rejected seller fee plus net are included');
      assert.equal(dashboard.totals.lifetimeFeeAtomic, '1035');
      assert.equal(dashboard.totals.lifetimeNetAtomic, '102370');
      assert.equal(dashboard.totals.monthNetAtomic, '102370');
      assert.equal(dashboard.totals.pendingAtomic, '2703', 'the submitted review-clock fixture and both unsettled funding records remain pending, not earned');
      const publicProfile = await getWorkerProfile(workerIds[0]);
      assert.equal(publicProfile.averageRating, 4);
      assert.equal(publicProfile.reviewCount, 1, 'unsigned or unconfirmed ratings are not public');
    });
  } catch (error) {
    if (error instanceof assert.AssertionError || (error instanceof Error && error.name === 'HttpError')) throw error;
    throw new Error('Isolated PostgreSQL experience integration test failed.');
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
      if (priorWorldEnvironment === undefined) delete process.env.WORLD_ID_ENVIRONMENT;
      else process.env.WORLD_ID_ENVIRONMENT = priorWorldEnvironment;
      if (priorWorkerAction === undefined) delete process.env.WORLD_ID_WORKER_ACTION;
      else process.env.WORLD_ID_WORKER_ACTION = priorWorkerAction;
    }
  }
});
