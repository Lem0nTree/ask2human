import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { closeDbForTests } from '../app/lib/server/db';
import type { Session } from '../app/lib/server/session';

try {
  process.loadEnvFile('.env');
} catch {
  // Live storage checks are opt-in when local configuration is present.
}

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const enabled = process.env.RUN_LIVE_STORAGE_TEST === '1' && !!databaseUrl && !!process.env.AWS_REGION && !!process.env.S3_BUCKET;
const serverOnlyLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20%7B%7D', shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/h2cAAAAASUVORK5CYII=',
  'base64',
);

function uploadRequest(taskId: string): Request {
  const form = new FormData();
  form.set('taskId', taskId);
  form.set('report', 'Generated storage smoke evidence; no person or location data.');
  form.set('file', new File([png], 'checker.png', { type: 'image/png' }));
  return new Request('https://test.invalid/api/evidence', { method: 'POST', body: form });
}

test('application evidence upload stays private, scoped, and write-once in S3', { skip: !enabled }, async (t) => {
  const schema = `groundwork_checker_${randomUUID().replaceAll('-', '')}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const admin = postgres(databaseUrl!, { max: 1, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
  let isolated: ReturnType<typeof postgres> | undefined;
  let objectKey: string | undefined;
  let phase = 'setup';
  let cleanupFailed = false;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const schemaUrl = new URL(databaseUrl!);
    schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = schemaUrl.toString();
    isolated = postgres(process.env.DATABASE_URL, { max: 4, idle_timeout: 2, connect_timeout: 8, onnotice: () => {} });
    const files = (await readdir(resolve('infra/migrations')))
      .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file)).sort();
    for (const file of files) {
      await isolated.unsafe(await readFile(resolve('infra/migrations', file), 'utf8'), [], { prepare: false });
    }

    const ownerId = randomUUID();
    const agentId = randomUUID();
    const workerId = randomUUID();
    const taskId = randomUUID();
    const workerWallet = `0x${'22'.repeat(32)}`;
    await isolated`
      INSERT INTO owners (id, oidc_issuer, oidc_subject)
      VALUES (${ownerId}, 'https://test.invalid', ${`checker-${ownerId}`})
    `;
    await isolated`
      INSERT INTO agents (id, owner_id, name, api_key_hash, scopes, categories, max_task_atomic, total_budget_atomic, reserved_atomic)
      VALUES (${agentId}, ${ownerId}, 'checker agent', ${'f'.repeat(64)}, ${isolated.array(['get_task'])}, ${isolated.array(['home'])}, 100, 100, 40)
    `;
    await isolated`
      INSERT INTO workers (id, display_name, category, area, status, wallet_address, wallet_verified_at, idkit_nullifier, idkit_verified_at)
      VALUES (${workerId}, 'checker worker', 'home', 'test area', 'VERIFIED', ${workerWallet}, now(), ${`0x${'33'.repeat(32)}`}, now())
    `;
    await isolated`
      INSERT INTO tasks (id, owner_id, agent_id, title, brief, category, area, rubric, amount_atomic, deadline, state, assigned_worker_id)
      VALUES (${taskId}, ${ownerId}, ${agentId}, 'Checker task', 'Generated storage smoke only', 'home', 'test area', '[]'::jsonb, 40,
        ${new Date(Date.now() + 60 * 60 * 1000)}, 'FUNDED', ${workerId})
    `;
    const workerSession: Session = {
      id: randomUUID(), rawToken: 'checker-session', csrfToken: 'checker-csrf',
      workerId, ownerId: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const ownerSession: Session = { ...workerSession, workerId: null, ownerId };
    const strangerSession: Session = { ...workerSession, workerId: null, ownerId: null };
    const { uploadEvidence, createEvidenceReadUrl } = await import('../app/lib/server/evidence');

    phase = 'application upload';
    const uploaded = await uploadEvidence(uploadRequest(taskId), workerSession);
    assert.equal(uploaded.evidence.mediaType, 'image/png');
    assert.equal(uploaded.evidence.byteLength, png.length);
    objectKey = `evidence/${taskId}/${uploaded.evidence.id}`;

    phase = 'authorized signed read';
    const workerRead = await createEvidenceReadUrl(uploaded.evidence.id, { session: workerSession });
    const ownerRead = await createEvidenceReadUrl(uploaded.evidence.id, { session: ownerSession });
    assert.equal(workerRead.sha256, ownerRead.sha256);
    const signedResponse = await fetch(workerRead.signedReadUrl);
    assert.equal(signedResponse.status, 200);
    assert.deepEqual(Buffer.from(await signedResponse.arrayBuffer()), png);

    phase = 'unauthorized read';
    await assert.rejects(
      createEvidenceReadUrl(uploaded.evidence.id, { session: strangerSession }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404),
    );
    await assert.rejects(
      createEvidenceReadUrl(uploaded.evidence.id, { agentId: randomUUID() }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404),
    );

    phase = 'direct unauthenticated object access';
    const directUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${objectKey}`;
    const directResponse = await fetch(directUrl);
    assert.notEqual(directResponse.status, 200, 'the S3 object must not be public');

    phase = 'write-once duplicate rejection';
    await assert.rejects(
      uploadEvidence(uploadRequest(taskId), workerSession),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'evidence_already_uploaded'),
    );
  } catch {
    throw new Error(`Application S3 smoke failed during ${phase}; no private URL or credentials are logged.`);
  } finally {
    if (objectKey) {
      const s3 = new S3Client({ region: process.env.AWS_REGION });
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }));
      } catch {
        cleanupFailed = true;
      } finally {
        s3.destroy();
      }
    }
    await closeDbForTests();
    if (isolated) await isolated.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 1 });
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (cleanupFailed) t.diagnostic('S3 DeleteObject is denied; a generated, private checker object remains in the bucket.');
  }
});
