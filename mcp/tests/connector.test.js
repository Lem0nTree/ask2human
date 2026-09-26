import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  DEFAULT_BASE_URL,
  readConfig,
  validateApiKey,
  validateBaseUrl,
} from '../src/config.js';
import { createApiClient, TOOL_DEFINITIONS } from '../src/server.js';

const API_KEY = `gw_live_${'a'.repeat(32)}`;
const TASK_ID = '123e4567-e89b-12d3-a456-426614174000';
const WORKER_ID = '223e4567-e89b-12d3-a456-426614174000';

function validTaskInput() {
  return {
    title: 'Photograph the storefront',
    brief: 'Take three clear photographs of the storefront from the public sidewalk.',
    category: 'photography',
    area: 'Downtown',
    rubric: ['Three sharp daylight photographs', 'No private property entered'],
    amountAtomic: '20000',
    deadline: '2026-09-27T12:00:00Z',
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function startHarness(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      let parsedBody;
      try {
        parsedBody = body ? JSON.parse(body) : undefined;
      } catch {
        parsedBody = undefined;
      }
      const entry = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: parsedBody,
      };
      requests.push(entry);
      try {
        const result = await handler(entry, requests);
        if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
        response.statusCode = result.status ?? 200;
        for (const [name, value] of Object.entries(result.headers ?? { 'content-type': 'application/json' })) response.setHeader(name, value);
        if (result.location) response.setHeader('location', result.location);
        response.end(result.body === undefined ? JSON.stringify(result.json ?? {}) : result.body);
      } catch {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { code: 'test_failure', message: 'test handler failed' } }));
      }
    });
  });
  const port = await listen(server);
  const client = new Client({ name: 'ask2human-connector-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/ask2human-mcp.js'],
    cwd: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
    env: {
      ASK2HUMAN_API_KEY: API_KEY,
      ASK2HUMAN_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  await client.connect(transport);
  return {
    client,
    requests,
    stderr,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await client.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('configuration validates the credential and origin trust boundary', () => {
  assert.equal(validateBaseUrl(DEFAULT_BASE_URL), DEFAULT_BASE_URL);
  assert.equal(validateBaseUrl('http://127.0.0.1:43123'), 'http://127.0.0.1:43123');
  assert.equal(validateBaseUrl('http://[::1]:43123'), 'http://[::1]:43123');
  assert.equal(validateApiKey(API_KEY), API_KEY);
  for (const url of [
    'http://example.com',
    'https://example.com/api',
    'https://example.com/?debug=1',
    'https://user:password@example.com',
    'https://example.com/#fragment',
  ]) assert.throws(() => validateBaseUrl(url), /ASK2HUMAN_BASE_URL/);
  assert.throws(() => validateApiKey('gw_live_short'), /ASK2HUMAN_API_KEY/);
  assert.throws(() => readConfig({ ASK2HUMAN_API_KEY: 'wrong' }), /ASK2HUMAN_API_KEY/);
});

test('stdio handshake exposes exactly the eight API tools and instructions', async () => {
  const harness = await startHarness(async () => ({ json: [] }));
  try {
    const listed = await harness.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), TOOL_DEFINITIONS.map((tool) => tool.name));
    assert.deepEqual(
      listed.tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name),
      ['search_workers', 'get_task', 'list_applicants'],
    );
    const serverVersion = harness.client.getServerVersion();
    assert.deepEqual(serverVersion, { name: 'ask2human', version: '0.1.0' });
    const instructions = harness.client.getInstructions();
    assert.match(instructions, /one worker/i);
    assert.match(instructions, /five minutes/i);
    assert.match(instructions, /wallet private key/i);
    assert.equal(harness.requests.length, 0);
  } finally {
    await harness.close();
  }
});

test('tool calls forward the exact API envelope and add human action links', async () => {
  const harness = await startHarness(async (request) => {
    if (request.body.tool === 'search_workers') return { json: [{ id: WORKER_ID, displayName: 'Ari' }] };
    if (request.body.tool === 'create_task') return { json: { id: TASK_ID, state: 'OPEN' } };
    if (request.body.tool === 'request_hire') return { json: { approvalId: 'approval-1', kind: 'HIRE', status: 'PENDING' } };
    return { json: { taskId: TASK_ID, state: 'SUBMITTED' } };
  });
  try {
    const workers = await harness.client.callTool({ name: 'search_workers', arguments: { category: 'photography', area: 'Downtown' } });
    assert.deepEqual(workers.structuredContent, { result: [{ id: WORKER_ID, displayName: 'Ari' }] });
    const created = await harness.client.callTool({ name: 'create_task', arguments: validTaskInput() });
    assert.equal(created.structuredContent.taskId, TASK_ID);
    assert.equal(created.structuredContent.taskUrl, `${harness.baseUrl}/tasks/${TASK_ID}`);
    const approval = await harness.client.callTool({ name: 'request_hire', arguments: { taskId: TASK_ID } });
    assert.equal(approval.structuredContent.taskId, TASK_ID);
    assert.equal(approval.structuredContent.ownerActionUrl, approval.structuredContent.taskUrl);
    assert.equal(approval.structuredContent.approvalId, 'approval-1');

    assert.equal(harness.requests.length, 3);
    for (const request of harness.requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/agent-tools');
      assert.equal(request.authorization, `Bearer ${API_KEY}`);
    }
    assert.deepEqual(harness.requests[0].body, {
      tool: 'search_workers',
      input: { category: 'photography', area: 'Downtown' },
    });
    assert.deepEqual(harness.requests[1].body, { tool: 'create_task', input: validTaskInput() });
  } finally {
    await harness.close();
  }
});

test('invalid tool names and strict arguments never reach the API', async () => {
  const harness = await startHarness(async () => ({ json: { unexpected: true } }));
  try {
    const invalidArgs = await harness.client.callTool({ name: 'search_workers', arguments: { category: 'NOT VALID!' } });
    assert.equal(invalidArgs.isError, true);
    await assert.rejects(() => harness.client.callTool({ name: 'not_a_real_tool', arguments: {} }), /not found/i);
    const invalidTask = await harness.client.callTool({ name: 'create_task', arguments: { ...validTaskInput(), amountAtomic: '0', extra: true } });
    assert.equal(invalidTask.isError, true);
    assert.equal(harness.requests.length, 0);
  } finally {
    await harness.close();
  }
});

test('401 and 403 API errors are safe isError results without credential or raw body echo', async () => {
  const leaked = `${API_KEY} raw backend detail`;
  let mode = 401;
  const harness = await startHarness(async () => ({
    status: mode,
    json: { error: { code: mode === 401 ? 'agent_credential_invalid' : 'agent_scope_required', message: leaked } },
  }));
  try {
    const unauthorized = await harness.client.callTool({ name: 'search_workers', arguments: {} });
    assert.equal(unauthorized.isError, true);
    assert.match(unauthorized.content[0].text, /agent_credential_invalid/);
    assert.doesNotMatch(unauthorized.content[0].text, new RegExp(API_KEY));
    mode = 403;
    const forbidden = await harness.client.callTool({ name: 'search_workers', arguments: {} });
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /agent_scope_required/);
    assert.doesNotMatch(forbidden.content[0].text, new RegExp(API_KEY));
  } finally {
    await harness.close();
  }
});

test('redirects are rejected before credentials can reach the destination', async () => {
  let finalCalls = 0;
  const finalServer = http.createServer((request, response) => {
    finalCalls++;
    assert.equal(request.headers.authorization, undefined);
    response.end(JSON.stringify({ ok: true }));
  });
  const finalPort = await listen(finalServer);
  const harness = await startHarness(async () => ({ status: 302, location: `http://127.0.0.1:${finalPort}/capture`, body: '' }));
  try {
    const result = await harness.client.callTool({ name: 'search_workers', arguments: {} });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, new RegExp(API_KEY));
    assert.equal(finalCalls, 0);
  } finally {
    await harness.close();
    await new Promise((resolve) => finalServer.close(resolve));
  }
});

test('API calls have a bounded timeout and do not retry', async () => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls++;
    request.resume();
    setTimeout(() => response.end(JSON.stringify({ ok: true })), 100);
  });
  const port = await listen(server);
  try {
    const client = createApiClient(
      { apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` },
      { timeoutMs: 20 },
    );
    const result = await client.call('search_workers', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /upstream_timeout/);
    assert.ok(calls <= 1, 'Timeouts must not retry a request');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

 test('timeout also covers a stalled response body after headers', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  const port = await listen(server);
  try {
    const client = createApiClient({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` }, { timeoutMs: 250 });
    const result = await client.call('search_workers', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /upstream_timeout/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
