import postgres, { type Sql } from 'postgres';

declare global {
  // Next dev reloads modules; retain one small pool per process.
  var __groundworkSql: Sql | undefined;
}

export function db(): Sql {
  const connectionString = process.env.ASK2HUMAN_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not configured');
  globalThis.__groundworkSql ??= postgres(connectionString, {
    // Keep each serverless instance small; Neon handles pooling upstream.
    max: process.env.VERCEL ? 3 : 8,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { undefined: null },
  });
  return globalThis.__groundworkSql;
}

export async function closeDbForTests(): Promise<void> {
  if (globalThis.__groundworkSql) {
    await globalThis.__groundworkSql.end({ timeout: 1 });
    globalThis.__groundworkSql = undefined;
  }
}
