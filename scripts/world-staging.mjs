// Local setup only. Team API key and returned token never enter browser code.
// Contract: https://docs.world.org/model-context-protocol/developer-portal
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function main() {
  if (!process.argv.includes('--enable')) throw new Error('Use --enable to open or renew the 24-hour staging window.');
  const apiKey = process.env.WORLD_DEVELOPER_API_KEY;
  const appId = process.env.WORLD_ID_APP_ID;
  const rpId = process.env.WORLD_ID_RP_ID;
  if (!apiKey || !appId || !rpId) throw new Error('Required local World setup configuration is missing.');
  if (!['staging', 'sandbox'].includes(process.env.WORLD_ID_ENVIRONMENT)) throw new Error('This setup script requires an explicitly configured test environment.');
  // Check local destination before rotating the one-time token remotely.
  await readFile('.env', 'utf8');
  let requestId = 0;
  async function callTool(name, args) {
    const response = await fetch('https://developer.world.org/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`World setup request failed (HTTP ${response.status}); no response payload logged.`);
    const envelope = await response.json();
    if (envelope.error || envelope.result?.isError) throw new Error('World rejected the setup request; no response payload logged.');
    const block = envelope.result?.content?.find((item) => item.type === 'text');
    return block ? JSON.parse(block.text) : envelope.result?.structuredContent;
  }
  // Check the remote app/RP before any operation that rotates its one-time token.
  const config = await callTool('get_app_config', { app_id: appId });
  if (config?.app?.id !== appId || config?.app?.rp_registration?.[0]?.rp_id !== rpId) {
    throw new Error('World setup app/RP configuration mismatch; no staging window changed.');
  }
  const result = await callTool('set_world_id_staging_verification', { app_id: appId, enabled: true });
  if (result?.rp_id !== rpId || typeof result?.staging_verification_token !== 'string' || !result.staging_verification_token || !Number.isFinite(Date.parse(result?.staging_verification_expires_at))) {
    throw new Error('World setup response failed validation; no response payload logged.');
  }
  const updates = {
    WORLD_ID_STAGING_VERIFICATION_TOKEN: result.staging_verification_token,
    WORLD_ID_STAGING_VERIFICATION_EXPIRES_AT: result.staging_verification_expires_at,
  };
  let source = await readFile('.env', 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const entry = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    source = pattern.test(source) ? source.replace(pattern, () => entry) : `${source.trimEnd()}\n${entry}\n`;
  }
  const temporary = `.env.staging-${randomUUID()}`;
  await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
  await rename(temporary, '.env');
  await chmod('.env', 0o600);
  console.log(`World staging window opened until ${result.staging_verification_expires_at}. Token saved privately to .env; configure it in Vercel before deployed verification.`);
}

main().catch((error) => {
  // Only local fixed errors are surfaced; never serialize an upstream response.
  const safe = error instanceof Error && /^(Use --enable|Required local|This setup|World setup|World rejected)/.test(error.message);
  console.error(safe ? error.message : 'World staging setup failed; secret-bearing details were suppressed.');
  process.exitCode = 1;
});
