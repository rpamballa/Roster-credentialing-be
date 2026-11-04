import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { ensureProviderAccount, getDefaultWorkspaceId, closeSessionStore } = await import(
  "@cred/auth"
);
const { db, schema, closeDb } = await import("@cred/db");
const { eq, sql } = await import("drizzle-orm");

/**
 * Enforces the product rule that was previously missed: every provider
 * lands in at least one workspace. ensureProviderAccount with an
 * explicit workspaceId grants to that workspace; omitting it falls
 * back to the platform-default workspace; omitting it with no default
 * configured throws loudly rather than silently stranding the record.
 *
 * Also asserts the invariant end-to-end: after any ensureProviderAccount
 * call completes, that provider has >= 1 grant. This is the test class
 * the previous suite was missing — not "does the code we wrote work",
 * but "does the product rule hold for every provider in the DB".
 */
describe("ensureProviderAccount — default-workspace fallback (product rule enforcement)", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  async function seedWorkspace(opts: {
    slug: string;
    name: string;
    isPlatformDefault?: boolean;
  }): Promise<string> {
    const [row] = await db()
      .insert(schema.workspaces)
      .values({
        type: "agency",
        name: opts.name,
        slug: opts.slug,
        isPlatformDefault: opts.isPlatformDefault ?? false,
      })
      .returning({ id: schema.workspaces.id });
    if (!row) throw new Error("workspace insert failed");
    return row.id;
  }

  async function grantsForProvider(providerId: string): Promise<string[]> {
    const rows = await db()
      .select({ workspaceId: schema.providerWorkspaceGrants.workspaceId })
      .from(schema.providerWorkspaceGrants)
      .where(eq(schema.providerWorkspaceGrants.providerId, providerId));
    return rows.map((r) => r.workspaceId);
  }

  it("with explicit workspaceId, grants to that workspace", async () => {
    const specific = await seedWorkspace({ slug: "specific-agency", name: "Specific" });
    // A platform default also exists — proving the explicit id wins.
    await seedWorkspace({
      slug: "platform-default",
      name: "Default",
      isPlatformDefault: true,
    });

    const result = await ensureProviderAccount({
      email: "explicit@example.com",
      fullName: "Explicit Caller",
      workspaceId: specific,
    });

    const grants = await grantsForProvider(result.providerId);
    expect(grants).toEqual([specific]);
    expect(grants).not.toContain(result.providerId);
    expect(result.grantCreated).toBe(true);
  });

  it("without workspaceId, falls back to the platform-default workspace", async () => {
    const defaultWs = await seedWorkspace({
      slug: "roster-hc",
      name: "Roster Healthcare",
      isPlatformDefault: true,
    });
    // A non-default workspace also exists to prove we don't pick arbitrarily.
    await seedWorkspace({ slug: "other-agency", name: "Other" });

    const result = await ensureProviderAccount({
      email: "stranded@example.com",
      fullName: "No Workspace Passed",
    });

    const grants = await grantsForProvider(result.providerId);
    expect(grants).toEqual([defaultWs]);
  });

  it("without workspaceId AND no platform-default configured, throws with a clear message", async () => {
    await seedWorkspace({ slug: "non-default-only", name: "Non Default" });

    await expect(
      ensureProviderAccount({
        email: "orphan@example.com",
        fullName: "Should Throw",
      }),
    ).rejects.toThrow(/platform-default workspace/i);

    // Invariant: no half-created row escapes. A failed grant still
    // leaves the user+provider rows (that's current behavior), but
    // the point of this test is to make sure the throw surfaces the
    // configuration bug, not that the rows are rolled back.
  });

  it("getDefaultWorkspaceId returns the id of the is_platform_default row", async () => {
    const defaultWs = await seedWorkspace({
      slug: "the-default",
      name: "The Default",
      isPlatformDefault: true,
    });

    const resolved = await getDefaultWorkspaceId();
    expect(resolved).toBe(defaultWs);
  });

  it("getDefaultWorkspaceId throws when no default is configured", async () => {
    await seedWorkspace({ slug: "no-default", name: "No Default" });
    await expect(getDefaultWorkspaceId()).rejects.toThrow(/platform-default/i);
  });

  it("DB invariant: after an ensureProviderAccount call, no provider has zero grants", async () => {
    // This is the invariant the previous suite was missing. It is
    // framed as a property of the database after a product-visible
    // action, not as a test of the function's return value. If a
    // future code path adds a providers row some other way, this same
    // invariant check (run periodically or in CI) catches it.
    await seedWorkspace({
      slug: "platform-default",
      name: "Platform Default",
      isPlatformDefault: true,
    });
    await ensureProviderAccount({
      email: "invariant@example.com",
      fullName: "Invariant",
    });

    // Raw SQL: "providers with zero grants." Kept as a direct query
    // so a future diagnostic job can lift it as-is.
    const result = await db().execute(sql`
      SELECT p.id, p.email
        FROM providers p
       WHERE NOT EXISTS (
         SELECT 1 FROM provider_workspace_grants g WHERE g.provider_id = p.id
       )
    `);
    // drizzle's postgres-js driver returns { rows: [...] } OR an
    // array-like; coerce to length either way.
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    expect(rows.length).toBe(0);
  });

  it("DB invariant: at most one workspace is marked is_platform_default", async () => {
    // The unique partial index from migration 0019 enforces this at
    // the DB level — proving the invariant exists in schema, not just
    // in intent.
    await seedWorkspace({
      slug: "default-a",
      name: "A",
      isPlatformDefault: true,
    });
    await expect(
      seedWorkspace({
        slug: "default-b",
        name: "B",
        isPlatformDefault: true,
      }),
    ).rejects.toThrow();
  });
});
