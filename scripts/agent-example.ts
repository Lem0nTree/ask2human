#!/usr/bin/env node
/**
 * Small runnable example for the scoped ask2human agent API.
 *
 * Run with: npx tsx scripts/agent-example.ts <command> [...args]
 * Configure ASK2HUMAN_URL and ASK2HUMAN_AGENT_KEY in the environment first.
 * This script never funds escrow or submits a wallet transaction.
 */
import { readFile } from 'node:fs/promises';

const usage = `ask2human agent example

Commands:
  post <task.json>                         Post a task from a JSON file
  get <taskId>                              Read one task
  applicants <taskId>                       List applicants
  select <taskId> <workerId>                Choose an applicant
  review <taskId> <accept|request_review> [note...]
  request-hire <taskId>                     Request owner approval for funding
  request-release <taskId>                  Request owner approval for release
  request-settlement <taskId>               Alias for request-release

Set ASK2HUMAN_URL to the app origin (or /api/agent-tools URL) and
ASK2HUMAN_AGENT_KEY to the agent bearer credential. Never put the credential
in a task file or command-line argument. Funding and settlement still require
the separately authorized owner wallet flow in the browser.
`;

function credentials() {
  const base = process.env.ASK2HUMAN_URL?.trim();
  const key = process.env.ASK2HUMAN_AGENT_KEY?.trim();
  if (!base || !key) throw new Error('Set ASK2HUMAN_URL and ASK2HUMAN_AGENT_KEY in the environment.');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error('ASK2HUMAN_URL must be an absolute URL.');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('ASK2HUMAN_URL must use HTTPS (HTTP is allowed for loopback development).');
  }
  if (parsed.username || parsed.password) throw new Error('ASK2HUMAN_URL must not contain URL credentials.');
  const endpoint = parsed.pathname.replace(/\/$/, '').endsWith('/api/agent-tools')
    ? parsed
    : new URL(`${parsed.pathname.replace(/\/$/, '')}/api/agent-tools`, parsed.origin);
  endpoint.search = '';
  endpoint.hash = '';
  return { endpoint, key };
}

function safeValue(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => safeValue(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      name,
      /authorization|api.?key|credential|secret|token/i.test(name) ? '[redacted]' : safeValue(item, secret),
    ]));
  }
  return value;
}

async function call(tool: string, input: unknown) {
  const { endpoint, key } = credentials();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool, input }),
  });
  const bodyText = await response.text();
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = { message: bodyText || response.statusText };
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body
      ? (body as { error?: { code?: string; message?: string } }).error
      : undefined;
    const message = [detail?.code, detail?.message].filter(Boolean).join(': ') || `Request failed (${response.status}).`;
    throw new Error(message.split(key).join('[redacted]'));
  }
  process.stdout.write(`${JSON.stringify(safeValue(body, key), null, 2)}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage);
    return;
  }
  switch (command) {
    case 'post': {
      if (!args[0] || args.length !== 1) throw new Error('Usage: post <task.json>');
      const task = JSON.parse(await readFile(args[0], 'utf8')) as unknown;
      await call('create_task', task);
      break;
    }
    case 'get':
      if (!args[0] || args.length !== 1) throw new Error('Usage: get <taskId>');
      await call('get_task', { taskId: args[0] });
      break;
    case 'applicants':
      if (!args[0] || args.length !== 1) throw new Error('Usage: applicants <taskId>');
      await call('list_applicants', { taskId: args[0] });
      break;
    case 'select':
      if (args.length !== 2) throw new Error('Usage: select <taskId> <workerId>');
      await call('select_worker', { taskId: args[0], workerId: args[1] });
      break;
    case 'review': {
      if (args.length < 2 || !['accept', 'request_review'].includes(args[1])) {
        throw new Error('Usage: review <taskId> <accept|request_review> [note...]');
      }
      const note = args.slice(2).join(' ').trim();
      await call('review_submission', { taskId: args[0], decision: args[1], ...(note ? { note } : {}) });
      break;
    }
    case 'request-hire':
      if (!args[0] || args.length !== 1) throw new Error('Usage: request-hire <taskId>');
      await call('request_hire', { taskId: args[0] });
      break;
    case 'request-release':
    case 'request-settlement':
      if (!args[0] || args.length !== 1) throw new Error(`Usage: ${command} <taskId>`);
      await call('request_release', { taskId: args[0] });
      break;
    default:
      throw new Error(`Unknown command “${command}”.\n\n${usage}`);
  }
}

main().catch((error: unknown) => {
  const key = process.env.ASK2HUMAN_AGENT_KEY ?? '';
  const message = error instanceof Error ? error.message : 'Agent API request failed.';
  process.stderr.write(`${key ? message.split(key).join('[redacted]') : message}\n`);
  process.exitCode = 1;
});
