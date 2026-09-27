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
    // CASCADE handles the FK tree — the anchor tables listed here
    // pull the rest (cases → documents/references/attestations/…,
    // workspaces → memberships/facility_profiles/provider_workspace_grants,
    // providers → cases via FK, etc). Users and facilities are added
    // explicitly because they aren't reached by cascading from the
    // others.
    await sql.unsafe(`
      TRUNCATE
        audit_log,
        magic_link_tokens,
        password_reset_tokens,
        case_notes,
        case_status_events,
        case_access_tokens,
        provider_invite_tokens,
        provider_workspace_grants,
        cases,
        providers,
        facility_profiles,
        facilities,
        memberships,
        workspaces,
        users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
