import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Set env BEFORE importing app code — @cred/config reads at import.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { buildApp } = await import("../src/app.js");
const { createSession, closeSessionStore } = await import("@cred/auth");
const { db, schema, closeDb } = await import("@cred/db");
const { eq } = await import("drizzle-orm");

// Minimal FacilityRequirements literal — enough to satisfy the
// NOT NULL + shape constraints on facility_profiles.requirements.
const EMPTY_REQS = {
  required_documents: [],
  required_verifications: [],
  privilege_delineations: [],
  attestations: [],
  submission: { method: "email" as const },
  facility_forms: [],
};

const app = buildApp();

/**
 * Auth-chain tests for /v1/cases/:caseId.
 *
 * These are the tests that would have caught the last three
 * shipped bugs (provider /signin loop, /welcome dead-end, and the
 * requireProviderTenancy 401 that broke every signed-in provider's
 * Open case tap). Each hits the real HTTP surface with a real
 * session cookie against a seeded Postgres so the middleware chain
 * exercises end-to-end.
 */
describe("/v1/cases/:caseId auth chain", () => {
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

  interface Seed {
    workspaceId: string;
    userId: string;
    providerId: string;
    caseId: string;
    otherCaseId: string;
  }

  async function seed(): Promise<Seed> {
    // Workspace + owner (staff who created things).
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Test Agency", slug: "test-agency", type: "agency" })
      .returning({ id: schema.workspaces.id });

    // The signed-in provider: has a users row + linked provider row +
    // grant on the workspace. This is what a real password-auth
    // provider looks like after they redeem their invite.
    const [user] = await db()
      .insert(schema.users)
      .values({
        email: "provider@example.com",
        name: "Test Provider",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "provider@example.com",
        firstName: "Test",
        lastName: "Provider",
        userId: user!.id,
      })
      .returning({ id: schema.providers.id });

    await db()
      .insert(schema.providerWorkspaceGrants)
      .values({ providerId: provider!.id, workspaceId: ws!.id, grantedBy: null });

    // Facility + approved profile so the case has somewhere to point.
    const [facility] = await db()
      .insert(schema.facilities)
      .values({ name: "Test Hospital" })
      .returning({ id: schema.facilities.id });

    const [profile] = await db()
      .insert(schema.facilityProfiles)
      .values({
        facilityId: facility!.id,
        workspaceId: ws!.id,
        version: 1,
        status: "approved",
        requirements: EMPTY_REQS,
      })
      .returning({ id: schema.facilityProfiles.id });

    // The provider's own case — the one they should be able to reach.
    const [ownCase] = await db()
      .insert(schema.cases)
      .values({
        workspaceId: ws!.id,
        providerId: provider!.id,
        facilityProfileId: profile!.id,
        facilityProfileVersion: "1",
        specialty: "Emergency Medicine",
        purpose: "initial_appointment",
        status: "awaiting_provider",
      })
      .returning({ id: schema.cases.id });

    // A case belonging to a DIFFERENT provider in the same workspace.
    // The signed-in provider must not be able to see it.
    const [other] = await db()
      .insert(schema.providers)
      .values({
        email: "other@example.com",
        firstName: "Other",
        lastName: "Provider",
        userId: null,
      })
      .returning({ id: schema.providers.id });

    const [otherCase] = await db()
      .insert(schema.cases)
      .values({
        workspaceId: ws!.id,
        providerId: other!.id,
        facilityProfileId: profile!.id,
        facilityProfileVersion: "1",
        specialty: "Cardiology",
        purpose: "initial_appointment",
        status: "awaiting_provider",
      })
      .returning({ id: schema.cases.id });

    return {
      workspaceId: ws!.id,
      userId: user!.id,
      providerId: provider!.id,
      caseId: ownCase!.id,
      otherCaseId: otherCase!.id,
    };
  }

  async function staffSession(userId: string, email: string): Promise<string> {
    return await createSession({ userId, email, activeWorkspaceId: null });
  }

  async function call(method: string, path: string, cookie?: string) {
    return app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: cookie ? { cookie: `cred_sid=${cookie}` } : {},
      }),
    );
  }

  it("staff session, own case → 200 (the fix for #41/#42)", async () => {
    const s = await seed();
    const sid = await staffSession(s.userId, "provider@example.com");
    const res = await call("GET", `/v1/cases/${s.caseId}`, sid);
    expect(res.status).toBe(200);
  });

  it("staff session, someone else's case → 401", async () => {
    const s = await seed();
    const sid = await staffSession(s.userId, "provider@example.com");
    const res = await call("GET", `/v1/cases/${s.otherCaseId}`, sid);
    expect(res.status).toBe(401);
  });

  it("no session → 401", async () => {
    const s = await seed();
    const res = await call("GET", `/v1/cases/${s.caseId}`);
    expect(res.status).toBe(401);
  });

  it("staff session with no linked provider → 401", async () => {
    const s = await seed();
    // Wipe the users→providers link and try again.
    await db()
      .update(schema.providers)
      .set({ userId: null })
      .where(eq(schema.providers.id, s.providerId));
    const sid = await staffSession(s.userId, "provider@example.com");
    const res = await call("GET", `/v1/cases/${s.caseId}`, sid);
    expect(res.status).toBe(401);
  });
});
