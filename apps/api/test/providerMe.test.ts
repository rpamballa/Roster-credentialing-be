import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
 * Tests for the /v1/provider/me/* bridge endpoints that power the
 * signed-in provider's /welcome flow.
 */
describe("/v1/provider/me/*", () => {
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

  async function seedLinkedProviderWithCase() {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({
        email: "p@example.com",
        name: "Test",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "p@example.com",
        firstName: "Test",
        lastName: "Provider",
        userId: user!.id,
      })
      .returning({ id: schema.providers.id });
    await db()
      .insert(schema.providerWorkspaceGrants)
      .values({ providerId: provider!.id, workspaceId: ws!.id, grantedBy: null });
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
    const [ownCase] = await db()
      .insert(schema.cases)
      .values({
        workspaceId: ws!.id,
        providerId: provider!.id,
        facilityProfileId: profile!.id,
        facilityProfileVersion: "1",
        specialty: "Anesthesia",
        purpose: "initial_appointment",
        status: "awaiting_provider",
      })
      .returning({ id: schema.cases.id });
    return {
      workspaceId: ws!.id,
      userId: user!.id,
      providerId: provider!.id,
      caseId: ownCase!.id,
    };
  }

  async function seedStaffNoProvider(): Promise<{ userId: string }> {
    const [user] = await db()
      .insert(schema.users)
      .values({
        email: "staff@example.com",
        name: "Staff",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    return { userId: user!.id };
  }

  async function staffCookie(userId: string, email: string): Promise<string> {
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

  describe("GET /v1/provider/me/cases", () => {
    it("returns linked provider's cases", async () => {
      const s = await seedLinkedProviderWithCase();
      const sid = await staffCookie(s.userId, "p@example.com");
      const res = await call("GET", "/v1/provider/me/cases", sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        providerId: string | null;
        cases: Array<{ id: string }>;
      };
      expect(body.providerId).toBe(s.providerId);
      expect(body.cases.map((c) => c.id)).toContain(s.caseId);
    });

    it("returns empty for staff with no linked provider (not 404 — /welcome renders waiting-room)", async () => {
      const s = await seedStaffNoProvider();
      const sid = await staffCookie(s.userId, "staff@example.com");
      const res = await call("GET", "/v1/provider/me/cases", sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        providerId: string | null;
        cases: unknown[];
      };
      expect(body.providerId).toBeNull();
      expect(body.cases).toEqual([]);
    });

    it("401 without a session", async () => {
      const res = await call("GET", "/v1/provider/me/cases");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/provider/me/cases/:caseId/open", () => {
    it("returns the direct case path (no more magic-link token)", async () => {
      const s = await seedLinkedProviderWithCase();
      const sid = await staffCookie(s.userId, "p@example.com");
      const res = await call("POST", `/v1/provider/me/cases/${s.caseId}/open`, sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string; caseId: string };
      expect(body.path).toBe(`/case/${s.caseId}`);
      expect(body.caseId).toBe(s.caseId);
    });

    it("404 when the case doesn't belong to this provider", async () => {
      const s = await seedLinkedProviderWithCase();
      // Seed a second provider + case in the same workspace.
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
          workspaceId: s.workspaceId,
          providerId: other!.id,
          facilityProfileId: null,
          facilityProfileVersion: null,
          specialty: "Radiology",
          purpose: "initial_appointment",
          status: "awaiting_provider",
        })
        .returning({ id: schema.cases.id });
      const sid = await staffCookie(s.userId, "p@example.com");
      const res = await call("POST", `/v1/provider/me/cases/${otherCase!.id}/open`, sid);
      expect(res.status).toBe(404);
    });

    it("403 for a staff user with no linked provider", async () => {
      const s = await seedStaffNoProvider();
      const sid = await staffCookie(s.userId, "staff@example.com");
      const res = await call(
        "POST",
        "/v1/provider/me/cases/00000000-0000-0000-0000-000000000000/open",
        sid,
      );
      expect(res.status).toBe(403);
    });
  });
});
