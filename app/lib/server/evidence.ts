import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from './db';
import { assert, HttpError } from './errors';
import { sha256, uuid } from './security';
import { workerForSession } from './identity';
import { safeEvidence } from './marketplace';
import type { Session } from './session';

// Leave enough room for multipart framing under the hosting function body cap.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 64 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
let client: S3Client | undefined;

function s3(): S3Client {
  const region = process.env.AWS_REGION;
  assert(region, 503, 'evidence_storage_not_configured', 'Evidence storage is not configured.');
  client ??= new S3Client({ region });
  return client;
}

function bucket(): string {
  const value = process.env.S3_BUCKET;
  assert(value, 503, 'evidence_storage_not_configured', 'Evidence storage is not configured.');
  return value;
}

export async function uploadEvidence(request: Request, session: Session) {
  const worker = await workerForSession(session);
  assert(worker.status === 'VERIFIED' && worker.wallet_address, 403, 'worker_not_ready', 'A verified worker with a signed payout wallet is required.');
  const requestBytes = await readRequestLimited(request, MAX_MULTIPART_BYTES);
  const form = await new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: requestBytes.buffer.slice(requestBytes.byteOffset, requestBytes.byteOffset + requestBytes.byteLength) as ArrayBuffer,
  }).formData();
  const taskId = form.get('taskId');
  const report = form.get('report');
  const file = form.get('file');
  assert(typeof taskId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(taskId), 400, 'invalid_task', 'A valid taskId is required.');
  assert(typeof report === 'string' && report.trim().length >= 1 && report.trim().length <= 5000, 400, 'invalid_report', 'Report must contain between 1 and 5000 characters.');
  assert(file instanceof File && file.size > 0 && file.size <= MAX_FILE_BYTES, 413, 'invalid_file_size', 'Upload one image no larger than 4 MiB.');
  assert(ALLOWED_TYPES.has(file.type), 415, 'file_type_rejected', 'Use a JPEG, PNG, or WebP image.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = identifyImageType(bytes);
  assert(mediaType && mediaType === file.type, 415, 'file_type_rejected', 'The image content does not match its declared type.');

  const normalizedReport = report.trim();
  const fileHash = sha256(bytes);
  const commitmentHash = `0x${sha256(`groundwork:evidence:v1\n${taskId}\n${fileHash}\n${normalizedReport}`)}`;
  const evidenceId = uuid();
  const objectKey = `evidence/${taskId}/${evidenceId}`;
  const [task] = await db()`
    SELECT t.id, t.state, t.assigned_worker_id,
           s.fee_quote_bps, s.funding_fee_bps, s.fee_acknowledged_at
    FROM tasks t LEFT JOIN settlements s ON s.task_id = t.id WHERE t.id = ${taskId}
  `;
  assert(task && task.assigned_worker_id === worker.id, 404, 'task_not_found', 'Task was not found for this worker.');
  assert(task.state === 'FUNDED', 409, 'task_not_funded', 'Evidence can be uploaded only after task funding is confirmed.');
  assert(!(task.fee_quote_bps != null && task.funding_fee_bps != null
    && Number(task.fee_quote_bps) !== Number(task.funding_fee_bps)
    && !task.fee_acknowledged_at), 409, 'fee_changed_acknowledgement_required', 'Review and accept the changed funding fee before uploading work.');
  const [existing] = await db()`SELECT id FROM evidence WHERE task_id = ${taskId}`;
  assert(!existing, 409, 'evidence_already_uploaded', 'This task already has evidence attached.');

  let stored = false;
  try {
    await s3().send(new PutObjectCommand({
      Bucket: bucket(),
      Key: objectKey,
      Body: bytes,
      ContentLength: bytes.length,
      ContentType: mediaType,
      ChecksumSHA256: Buffer.from(fileHash, 'hex').toString('base64'),
      ServerSideEncryption: 'AES256',
    }));
    stored = true;

    await db().begin(async (tx) => {
      const [lockedTask] = await tx`SELECT id, state, assigned_worker_id FROM tasks WHERE id = ${taskId} FOR UPDATE`;
      assert(lockedTask && lockedTask.assigned_worker_id === worker.id && lockedTask.state === 'FUNDED', 409, 'task_changed', 'Task changed before evidence could be attached.');
      const [prior] = await tx`SELECT id FROM evidence WHERE task_id = ${taskId}`;
      assert(!prior, 409, 'evidence_already_uploaded', 'This task already has evidence attached.');
      await tx`
        INSERT INTO evidence (id, task_id, worker_id, object_key, media_type, byte_length, sha256, report, commitment_hash)
        VALUES (${evidenceId}, ${taskId}, ${worker.id}, ${objectKey}, ${mediaType}, ${bytes.length}, ${fileHash}, ${normalizedReport}, ${commitmentHash})
      `;
      await tx`
        INSERT INTO audit_events (actor_type, actor_id, task_id, event_type, safe_detail)
        VALUES ('worker', ${worker.id}, ${taskId}, 'evidence_uploaded', ${tx.json({ byteLength: bytes.length, mediaType })})
      `;
    });
  } catch (error) {
    if (stored) await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: objectKey })).catch(() => undefined);
    throw error;
  }
  return { evidence: { id: evidenceId, mediaType, byteLength: bytes.length, sha256: fileHash }, commitmentHash };
}

export async function createEvidenceReadUrl(evidenceId: string, actor: { session?: Session; agentId?: string }) {
  const [row] = await db()`
    SELECT e.id, e.object_key, e.media_type, e.byte_length, e.sha256, e.report, e.uploaded_at,
           t.owner_id, t.assigned_worker_id, t.agent_id
    FROM evidence e JOIN tasks t ON t.id = e.task_id WHERE e.id = ${evidenceId}
  `;
  assert(row, 404, 'evidence_not_found', 'Evidence was not found.');
  if (actor.agentId) assert(row.agent_id === actor.agentId, 404, 'evidence_not_found', 'Evidence was not found for this agent.');
  else {
    const session = actor.session;
    assert(session && (session.ownerId === row.owner_id || session.workerId === row.assigned_worker_id), 404, 'evidence_not_found', 'Evidence was not found for this account.');
  }
  const command = new GetObjectCommand({ Bucket: bucket(), Key: row.object_key, ResponseContentType: row.media_type });
  const signedReadUrl = await getSignedUrl(s3(), command, { expiresIn: 60 });
  return { ...safeEvidence(row), signedReadUrl, expiresInSeconds: 60 };
}

async function readRequestLimited(request: Request, limit: number): Promise<Uint8Array> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > limit) throw new HttpError(413, 'upload_too_large', 'Upload must be no larger than 4 MiB plus form fields.');
  assert(request.body, 400, 'missing_body', 'Upload body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, 'upload_too_large', 'Upload must be no larger than 4 MiB plus form fields.');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function identifyImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
