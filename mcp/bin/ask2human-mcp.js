#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

try {
  const config = readConfig();
  serveStdio(
    () => createServer({ config }),
    { onerror: () => console.error('[ask2human-mcp] MCP transport error.') },
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Invalid connector configuration.';
  console.error(`[ask2human-mcp] ${message}`);
  process.exitCode = 1;
}
