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
const { issueCaseAccessToken, issueProviderInviteToken, closeSessionStore } = await import(
  "@cred/auth"
);
const { db, schema, closeDb } = await import("@cred/db");
const { eq } = await import("drizzle-orm");

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
 * Provider auth entrypoints — the surface every unauthenticated provider
 * hits first. Before this test file: zero coverage. A token-expiry or
 * single-use bug would only surface when a real invite email started
 * failing in prod.
 */
describe("/provider/auth/*", () => {
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

  async function seedCase(): Promise<{
    workspaceId: string;
    providerId: string;
    caseId: string;
  }> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "A", slug: "a", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [provider] = await db()
      .insert(schema.providers)
      .values({ email: "p@a.example", firstName: "Test", lastName: "Prov", userId: null })
      .returning({ id: schema.providers.id });
    const [facility] = await db()
      .insert(schema.facilities)
      .values({ name: "Hosp" })
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
    return { workspaceId: ws!.id, providerId: provider!.id, caseId: cs!.id };
  }

  async function seedWorkspace(): Promise<string> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "A", slug: "a", type: "agency" })
      .returning({ id: schema.workspaces.id });
    return ws!.id;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    };
    return app.fetch(new Request(`http://localhost${path}`, init));
  }

  // ─── POST /provider/auth/redeem — case-scoped magic-link ────────────────
  describe("POST /provider/auth/redeem", () => {
    it("valid token → 200, mints session cookie, returns caseId/providerId", async () => {
      const s = await seedCase();
      const { token } = await issueCaseAccessToken({
        caseId: s.caseId,
        providerId: s.providerId,
        workspaceId: s.workspaceId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const res = await call("POST", "/provider/auth/redeem", { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; caseId: string; providerId: string };
      expect(body).toEqual({ ok: true, caseId: s.caseId, providerId: s.providerId });
      // Session cookie must be set.
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/cred_sid=/);
    });

    it("expired token → 400", async () => {
      const s = await seedCase();
      const { token } = await issueCaseAccessToken({
        caseId: s.caseId,
        providerId: s.providerId,
        workspaceId: s.workspaceId,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const res = await call("POST", "/provider/auth/redeem", { token });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("invalid-token");
    });

    it("revoked token → 400", async () => {
      const s = await seedCase();
      const { token, tokenId } = await issueCaseAccessToken({
        caseId: s.caseId,
        providerId: s.providerId,
        workspaceId: s.workspaceId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await db()
        .update(schema.caseAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.caseAccessTokens.id, tokenId));
      const res = await call("POST", "/provider/auth/redeem", { token });
      expect(res.status).toBe(400);
    });

    it("bogus token → 400", async () => {
      const res = await call("POST", "/provider/auth/redeem", { token: "x".repeat(64) });
      expect(res.status).toBe(400);
    });

    it("too-short token → 400 (zod)", async () => {
      const res = await call("POST", "/provider/auth/redeem", { token: "short" });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /provider/auth/preview — case- or workspace-scope ─────────────
  describe("POST /provider/auth/preview", () => {
    it("case-scope token → returns kind=case + provider first name", async () => {
      const s = await seedCase();
      // Update provider first name so we can assert it round-trips.
      await db()
        .update(schema.providers)
        .set({ firstName: "Ada" })
        .where(eq(schema.providers.id, s.providerId));
      const { token } = await issueCaseAccessToken({
        caseId: s.caseId,
        providerId: s.providerId,
        workspaceId: s.workspaceId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const res = await call("POST", "/provider/auth/preview", { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        kind: string;
        providerFirstName: string;
        workspaceName: string;
        facilityName: string;
      };
      expect(body.kind).toBe("case");
      expect(body.providerFirstName).toBe("Ada");
      expect(body.workspaceName).toBe("A");
      expect(body.facilityName).toBe("Hosp");
    });

    it("workspace-scope token → returns kind=workspace + provider first name", async () => {
      const workspaceId = await seedWorkspace();
      const { token } = await issueProviderInviteToken({
        workspaceId,
        email: "new@a.example",
        fullName: "Ben Smith",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const res = await call("POST", "/provider/auth/preview", { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        kind: string;
        workspaceName: string;
        providerFirstName: string;
        email: string;
      };
      expect(body.kind).toBe("workspace");
      expect(body.workspaceName).toBe("A");
      expect(body.providerFirstName).toBe("Ben");
      expect(body.email).toBe("new@a.example");
    });

    it("does NOT consume the token (can redeem after preview)", async () => {
      const s = await seedCase();
      const { token } = await issueCaseAccessToken({
        caseId: s.caseId,
        providerId: s.providerId,
        workspaceId: s.workspaceId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const previewRes = await call("POST", "/provider/auth/preview", { token });
      expect(previewRes.status).toBe(200);
      // Subsequent redeem still works — preview did not consume.
      const redeemRes = await call("POST", "/provider/auth/redeem", { token });
      expect(redeemRes.status).toBe(200);
    });
  });

  // ─── POST /provider/auth/redeem-invite — workspace-scope only ───────────
  describe("POST /provider/auth/redeem-invite", () => {
    it("valid workspace invite → 200, creates provider account + grant", async () => {
      const workspaceId = await seedWorkspace();
      const { token } = await issueProviderInviteToken({
        workspaceId,
        email: "new@a.example",
        fullName: "Ben Smith",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const res = await call("POST", "/provider/auth/redeem-invite", { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; providerId: string; workspaceId: string };
      expect(body.ok).toBe(true);
      expect(body.workspaceId).toBe(workspaceId);

      // Provider row exists.
      const providers = await db()
        .select({ id: schema.providers.id, email: schema.providers.email })
        .from(schema.providers)
        .where(eq(schema.providers.id, body.providerId));
      expect(providers).toHaveLength(1);
      expect(providers[0]?.email).toBe("new@a.example");

      // Grant on this workspace exists.
      const grants = await db()
        .select({ workspaceId: schema.providerWorkspaceGrants.workspaceId })
        .from(schema.providerWorkspaceGrants)
        .where(eq(schema.providerWorkspaceGrants.providerId, body.providerId));
      expect(grants.map((g) => g.workspaceId)).toContain(workspaceId);
    });

    it("expired invite → 400", async () => {
      const workspaceId = await seedWorkspace();
      const { token } = await issueProviderInviteToken({
        workspaceId,
        email: "new@a.example",
        fullName: null,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const res = await call("POST", "/provider/auth/redeem-invite", { token });
      expect(res.status).toBe(400);
    });

    it("second redemption → 400 (single-use)", async () => {
      const workspaceId = await seedWorkspace();
      const { token } = await issueProviderInviteToken({
        workspaceId,
        email: "new@a.example",
        fullName: "Ben Smith",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const first = await call("POST", "/provider/auth/redeem-invite", { token });
      expect(first.status).toBe(200);
      const second = await call("POST", "/provider/auth/redeem-invite", { token });
      expect(second.status).toBe(400);
    });

    it("does NOT mint a session (subsequent /me is 401)", async () => {
      const workspaceId = await seedWorkspace();
      const { token } = await issueProviderInviteToken({
        workspaceId,
        email: "new@a.example",
        fullName: "Ben Smith",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const res = await call("POST", "/provider/auth/redeem-invite", { token });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie ?? "").not.toMatch(/cred_sid=/);
    });
  });
});
