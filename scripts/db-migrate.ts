import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// Explicit opt-in prevents local development migrations from targeting production.
const connectionString = process.env.MIGRATE_HOSTED === '1'
  ? process.env.DATABASE_URL_UNPOOLED
  : process.env.DATABASE_URL;
if (!connectionString) throw new Error(process.env.MIGRATE_HOSTED === '1'
  ? 'DATABASE_URL_UNPOOLED is required for hosted migrations'
  : 'DATABASE_URL is required');

const sql = postgres(connectionString, { max: 1, idle_timeout: 5, onnotice: () => {} });
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const files = (await readdir(resolve('infra/migrations')))
    .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/i, '');
    const alreadyApplied = await sql`SELECT 1 FROM schema_migrations WHERE version = ${version}`;
    if (alreadyApplied.length > 0) {
      process.stdout.write(`Already applied ${version}\n`);
      continue;
    }
    const source = await readFile(resolve('infra/migrations', file), 'utf8');
    await sql.begin(async (tx) => {
      // Migration files are trusted repository SQL; each version runs once.
      await tx.unsafe(source, [], { prepare: false });
      await tx`INSERT INTO schema_migrations (version) VALUES (${version}) ON CONFLICT DO NOTHING`;
    });
    process.stdout.write(`Applied ${version}\n`);
  }
} finally {
  await sql.end();
}
