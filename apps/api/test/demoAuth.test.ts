import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { closeSessionStore } = await import("@cred/auth");
const { db, schema, closeDb } = await import("@cred/db");

const EMPTY_REQS = {
  required_documents: [],
  required_verifications: [],
  privilege_delineations: [],
  attestations: [],
  submission: { method: "email" as const },
  facility_forms: [],
};

/**
 * Demo-auth surface — staging-only side channel that mints sessions
 * without credentials. Two critical properties to guard:
 *
 *   1. When DEMO_AUTH_ENABLED != "true", the routes 404 — the endpoint's
 *      existence must not be discoverable by probes.
 *   2. Every issuance writes an audit row. If someone abuses the demo
 *      path in staging, the audit log is the trail.
 *
 * The file is flagged for deletion before real production (see the
 * banner in demoAuth.ts). Until then, these tests keep the gates honest.
 */
describe("/auth/dev/demo-signin", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterEach(() => {
    // Reset the feature flag so cross-test pollution can't fake a pass.
    process.env.DEMO_AUTH_ENABLED = undefined;
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  async function buildAppFresh() {
    // Rebuild the app between flag flips so the demo-mount picks up the
    // current env. buildApp re-reads the flag at call time.
    const { buildApp } = await import("../src/app.js");
    return buildApp();
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const app = await buildAppFresh();
    const init: RequestInit = {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    };
    return app.fetch(new Request(`http://localhost${path}`, init));
  }

  async function seedUserWithWorkspace(email: string): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "A", slug: "a", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email, name: "T", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
    return { userId: user!.id, workspaceId: ws!.id };
  }

  // ─── Feature gate — the safety net ─────────────────────────────────────
  describe("when DEMO_AUTH_ENABLED is off", () => {
    it("staff demo-signin returns 404 (route existence not disclosed)", async () => {
      process.env.DEMO_AUTH_ENABLED = "";
      await seedUserWithWorkspace("jamie@a.example");
      const res = await call("POST", "/auth/dev/demo-signin", { email: "jamie@a.example" });
      expect(res.status).toBe(404);
    });

    it("provider demo-signin returns 404", async () => {
      process.env.DEMO_AUTH_ENABLED = "";
      const res = await call("POST", "/auth/dev/demo-provider-signin", {
        caseId: "00000000-0000-0000-0000-000000000000",
      });
      expect(res.status).toBe(404);
    });

    it('flag = "1" is NOT enough — must be the exact string "true"', async () => {
      process.env.DEMO_AUTH_ENABLED = "1";
      await seedUserWithWorkspace("jamie@a.example");
      const res = await call("POST", "/auth/dev/demo-signin", { email: "jamie@a.example" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Staff demo-signin ─────────────────────────────────────────────────
  describe("staff demo-signin when enabled", () => {
    beforeEach(() => {
      process.env.DEMO_AUTH_ENABLED = "true";
    });

    it("known user → 200, session cookie set, audit row written", async () => {
      const seed = await seedUserWithWorkspace("jamie@a.example");
      const res = await call("POST", "/auth/dev/demo-signin", { email: "jamie@a.example" });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie") ?? "").toMatch(/cred_sid=/);

      const audits = await db()
        .select({ action: schema.auditLog.action, targetEntityId: schema.auditLog.targetEntityId })
        .from(schema.auditLog);
      expect(audits.map((a) => a.action)).toContain("auth.demo_signin");
      const demoRow = audits.find((a) => a.action === "auth.demo_signin");
      expect(demoRow?.targetEntityId).toBe(seed.userId);
    });

    it("unknown email → 403 (opaque refusal, no user-existence leak)", async () => {
      const res = await call("POST", "/auth/dev/demo-signin", { email: "nobody@a.example" });
      expect(res.status).toBe(403);
    });

    it("invalid email shape → 400 (zod)", async () => {
      const res = await call("POST", "/auth/dev/demo-signin", { email: "not-an-email" });
      expect(res.status).toBe(400);
    });
  });

  // ─── Provider demo-signin ──────────────────────────────────────────────
  describe("provider demo-signin when enabled", () => {
    beforeEach(() => {
      process.env.DEMO_AUTH_ENABLED = "true";
    });

    async function seedCase(): Promise<{ caseId: string; workspaceId: string }> {
      const [ws] = await db()
        .insert(schema.workspaces)
        .values({ name: "A", slug: "a", type: "agency" })
        .returning({ id: schema.workspaces.id });
      const [provider] = await db()
        .insert(schema.providers)
        .values({ email: "p@a.example", firstName: "P", lastName: "Q", userId: null })
        .returning({ id: schema.providers.id });
      const [facility] = await db()
        .insert(schema.facilities)
        .values({ name: "H" })
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
      const [cs] = await db()
        .insert(schema.cases)
        .values({
          workspaceId: ws!.id,
          providerId: provider!.id,
          facilityProfileId: profile!.id,
          facilityProfileVersion: "1",
          specialty: "EM",
          purpose: "initial_appointment",
          status: "awaiting_provider",
        })
        .returning({ id: schema.cases.id });
      return { caseId: cs!.id, workspaceId: ws!.id };
    }

    it("known caseId → 200, session cookie set, redirectPath includes case id", async () => {
      const seed = await seedCase();
      const res = await call("POST", "/auth/dev/demo-provider-signin", { caseId: seed.caseId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; redirectPath: string };
      expect(body.ok).toBe(true);
      expect(body.redirectPath).toBe(`/case/${seed.caseId}`);
      expect(res.headers.get("set-cookie") ?? "").toMatch(/cred_sid=/);
    });

    it("unknown caseId → 403", async () => {
      const res = await call("POST", "/auth/dev/demo-provider-signin", {
        caseId: "00000000-0000-0000-0000-000000000000",
      });
      expect(res.status).toBe(403);
    });

    it("non-uuid caseId → 400 (zod)", async () => {
      const res = await call("POST", "/auth/dev/demo-provider-signin", { caseId: "abc" });
      expect(res.status).toBe(400);
    });
  });
});
