// Mirrors `packages/signal-ingest/test/setup.ts` — tests hit the
// same Postgres and share the Signal schema via @cred/db's
// migrations. Using `migrate` against the shipped migrations folder
// means a fresh DB is enough; no manual DDL in this package.
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
        workspaces,
        providers,
        users,
        facilities
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
