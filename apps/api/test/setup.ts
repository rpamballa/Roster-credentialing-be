import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import postgres from "postgres";

// Spin up the schema once per worker. Each test truncates between runs.
const MIGRATIONS_DIR = new URL("../../../packages/db/migrations", import.meta.url).pathname;

/**
 * Flush the Redis test DB so rate-limit buckets from prior test runs
 * don't 429 endpoints that limit per IP (e.g. /v1/marketing/leads at
 * 5/hour/IP). Called by truncateAll so every test starts with a clean
 * slate for both Postgres AND Redis.
 */
async function flushRedis(): Promise<void> {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379/1";
  const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.flushdb();
  } catch {
    // Redis may not be reachable in some minimal setups; the rate
    // limiter fails open there, so nothing to do.
  } finally {
    redis.disconnect();
  }
}

export async function ensureSchema(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function truncateAll(url: string): Promise<void> {
  await flushRedis();
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
        marketing_leads,
        inbound_emails,
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
