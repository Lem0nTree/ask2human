// Creates an anonymous session only; does not create identities, tasks or payments.
import assert from 'node:assert/strict';

const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/deployment-smoke.mjs https://ask2human.me');
const origin = new URL(target).origin;
async function request(path, options = {}) {
  return fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(30000), ...options });
}
for (const path of ['/', '/work', '/agents']) {
  const response = await request(path);
  assert.equal(response.status, 200, `${path} status`);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/, `${path} content type`);
  await response.arrayBuffer();
  console.log(`PASS page ${path}`);
}
const response = await request('/api/state');
assert.equal(response.status, 200, 'anonymous state');
assert.match(response.headers.get('cache-control') ?? '', /no-store/);
const state = await response.json();
assert.equal(typeof state.csrfToken, 'string');
const setCookie = response.headers.get('set-cookie') ?? '';
assert.match(setCookie, /HttpOnly/i);
assert.match(setCookie, /SameSite=Lax/i);
if (origin.startsWith('https:')) assert.match(setCookie, /;\s*Secure/i);
const cookie = setCookie.split(';')[0];
assert.ok(cookie.startsWith('groundwork_session='));
const resumed = await request('/api/state', { headers: { cookie } });
assert.equal(resumed.status, 200);
assert.equal((await resumed.json()).csrfToken, state.csrfToken, 'persistent session');
console.log('PASS anonymous session, cookie flags and persistence');

for (const [path, headers, status, code] of [
  ['/api/actions', { origin }, 401, 'session_required'],
  ['/api/actions', { origin, cookie }, 403, 'csrf_rejected'],
  ['/api/actions', { origin: 'https://untrusted.invalid', cookie, 'x-csrf-token': state.csrfToken }, 403, 'origin_rejected'],
  ['/api/experience', { origin, cookie }, 403, 'csrf_rejected'],
  ['/api/evidence', { origin, cookie }, 403, 'csrf_rejected'],
  ['/api/evidence', { origin, cookie, 'x-csrf-token': state.csrfToken }, 401, 'worker_required'],
  ['/api/agent-tools', {}, 401, 'agent_credential_required'],
]) {
  const denied = await request(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  const body = await denied.json();
  assert.equal(denied.status, status, `${path} denial status`);
  assert.equal(body.error?.code, code, `${path} denial reason`);
  console.log(`PASS ${path} rejects ${code}`);
}
const tasks = await request('/api/experience?view=tasks');
assert.equal(tasks.status, 200, 'public task listing');
assert.ok(Array.isArray((await tasks.json()).tasks));
console.log('PASS public task listing');
const evidence = await request('/api/evidence/00000000-0000-4000-8000-000000000000');
assert.equal(evidence.status, 401, 'evidence requires a session');
assert.equal((await evidence.json()).error?.code, 'session_required');
console.log('PASS anonymous evidence access denied');
console.log('Deployment HTTP smoke passed; authenticated identity, wallet and payment journeys require separate acceptance.');
