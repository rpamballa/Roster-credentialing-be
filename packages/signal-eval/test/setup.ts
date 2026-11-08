// Mirrors `packages/db/test/setup.ts` and `packages/signal-ingest/
// test/setup.ts`. Tests hit real Postgres and share the `signal_*`
// schema via @cred/db's migrations folder.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

process.env.DATABASE_URL ??= "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.NODE_ENV ??= "test";

const MIGRATIONS_DIR = new URL("../../db/migrations", import.meta.url).pathname;

export async function ensureSchema(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function truncateAll(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      TRUNCATE
        signal_eval_runs,
        signal_weights,
        signal_source_lineage,
        signal_overrides,
        signal_rankings,
        signal_extracts,
        signal_conversations,
        signal_credentials,
        signal_jobs,
        signal_providers,
        workspaces,
        users,
        facilities
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
