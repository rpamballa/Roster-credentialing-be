import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Spin up the schema once per worker. Each test truncates between runs.
const MIGRATIONS_DIR = new URL("../../../packages/db/migrations", import.meta.url).pathname;

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
        audit_log,
        magic_link_tokens,
        memberships,
        workspaces,
        users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
