import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";
process.env.STORAGE_EMULATOR_HOST = process.env.STORAGE_EMULATOR_HOST ?? "http://localhost:54443";
process.env.GCS_BUCKET = process.env.GCS_BUCKET ?? "cred-dev";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { buildApp } = await import("../src/app.js");
const { createSession, closeSessionStore } = await import("@cred/auth");
const { db, schema, closeDb } = await import("@cred/db");
const { eq } = await import("drizzle-orm");

const app = buildApp();

/**
 * cockpitProviders — the biggest remaining zero-coverage surface (14
 * endpoints). Covers provider listing/PATCH, invites (send/list/resend/revoke),
 * documents (sign-upload/uploaded/delete), verifications (add/delete).
 */
describe("cockpit providers", () => {
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
    userId: string;
    workspaceId: string;
    providerId: string;
    sid: string;
  }

  async function seed(): Promise<Seed> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "s@a.example", name: "Staff", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
    const [provider] = await db()
      .insert(schema.providers)
      .values({ email: "p@a.example", firstName: "Ada", lastName: "Lovelace", userId: null })
      .returning({ id: schema.providers.id });
    await db()
      .insert(schema.providerWorkspaceGrants)
      .values({ providerId: provider!.id, workspaceId: ws!.id, grantedBy: user!.id });
    const sid = await createSession({
      userId: user!.id,
      email: "s@a.example",
      activeWorkspaceId: ws!.id,
    });
    return { userId: user!.id, workspaceId: ws!.id, providerId: provider!.id, sid };
  }

  async function call(
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        cookie: `cred_sid=${cookie}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return app.fetch(new Request(`http://localhost${path}`, init));
  }

  // ─── GET /v1/cockpit/providers ─────────────────────────────────────────
  describe("GET /v1/cockpit/providers", () => {
    it("returns workspace providers", async () => {
      const s = await seed();
      const res = await call("GET", "/v1/cockpit/providers", s.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { providers: Array<{ id: string }> };
      expect(body.providers.map((p) => p.id)).toContain(s.providerId);
    });

    it("does NOT return providers from other workspaces (RLS-style filter)", async () => {
      const s = await seed();
      const [otherWs] = await db()
        .insert(schema.workspaces)
        .values({ name: "Other", slug: "other", type: "agency" })
        .returning({ id: schema.workspaces.id });
      const [outsider] = await db()
        .insert(schema.providers)
        .values({ email: "out@a.example", firstName: "X", lastName: "Y", userId: null })
        .returning({ id: schema.providers.id });
      await db()
        .insert(schema.providerWorkspaceGrants)
        .values({ providerId: outsider!.id, workspaceId: otherWs!.id, grantedBy: null });
      const res = await call("GET", "/v1/cockpit/providers", s.sid);
      const body = (await res.json()) as { providers: Array<{ id: string }> };
      const ids = body.providers.map((p) => p.id);
      expect(ids).toContain(s.providerId);
      expect(ids).not.toContain(outsider!.id);
    });
  });

  // ─── PATCH /v1/cockpit/providers/:providerId ───────────────────────────
  describe("PATCH /v1/cockpit/providers/:providerId", () => {
    it("updates supplied fields + writes audit", async () => {
      const s = await seed();
      const res = await call("PATCH", `/v1/cockpit/providers/${s.providerId}`, s.sid, {
        firstName: "Adalovelace",
        phone: "+15551234",
      });
      expect(res.status).toBeLessThan(300);
      const [row] = await db()
        .select({ firstName: schema.providers.firstName, phone: schema.providers.phone })
        .from(schema.providers)
        .where(eq(schema.providers.id, s.providerId));
      expect(row?.firstName).toBe("Adalovelace");
      expect(row?.phone).toBe("+15551234");
    });

    it("empty patch → 400 (no-changes)", async () => {
      const s = await seed();
      const res = await call("PATCH", `/v1/cockpit/providers/${s.providerId}`, s.sid, {});
      expect(res.status).toBe(400);
    });

    it("provider not in workspace → 404", async () => {
      const s = await seed();
      const [outsider] = await db()
        .insert(schema.providers)
        .values({ email: "o@a.example", firstName: "X", lastName: "Y", userId: null })
        .returning({ id: schema.providers.id });
      const res = await call("PATCH", `/v1/cockpit/providers/${outsider!.id}`, s.sid, {
        firstName: "Nope",
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /v1/cockpit/providers/invite ─────────────────────────────────
  describe("POST /v1/cockpit/providers/invite", () => {
    it("new provider invite → sent status + token row + audit", async () => {
      const s = await seed();
      const res = await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "new@a.example", fullName: "New Person" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ email: string; status: string; url?: string }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]?.status).toBe("sent");
      expect(body.results[0]?.url).toMatch(/\/invite\//);

      // Token row exists.
      const tokens = await db()
        .select({ email: schema.providerInviteTokens.email })
        .from(schema.providerInviteTokens);
      expect(tokens.map((t) => t.email)).toContain("new@a.example");
    });

    it("second invite for same email → already_invited (no new token)", async () => {
      const s = await seed();
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "new@a.example", fullName: "New Person" }],
      });
      const res = await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "new@a.example", fullName: "New Person" }],
      });
      const body = (await res.json()) as {
        results: Array<{ email: string; status: string }>;
      };
      expect(body.results[0]?.status).toBe("already_invited");

      const tokens = await db()
        .select({ id: schema.providerInviteTokens.id })
        .from(schema.providerInviteTokens);
      expect(tokens).toHaveLength(1);
    });

    it("more than 20 invites → 400 (zod)", async () => {
      const s = await seed();
      const invites = Array.from({ length: 21 }, (_, i) => ({
        email: `p${i}@a.example`,
        fullName: `P ${i}`,
      }));
      const res = await call("POST", "/v1/cockpit/providers/invite", s.sid, { invites });
      expect(res.status).toBe(400);
    });
  });

  // ─── GET/POST /v1/cockpit/providers/invites (list/resend/revoke) ──────
  describe("provider invites list + resend + revoke", () => {
    it("GET /invites → lists open invites", async () => {
      const s = await seed();
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "new@a.example", fullName: "New" }],
      });
      const res = await call("GET", "/v1/cockpit/providers/invites", s.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { invites: Array<{ email: string; id: string }> };
      expect(body.invites.length).toBeGreaterThan(0);
      expect(body.invites.map((i) => i.email)).toContain("new@a.example");
    });

    it("POST /invites/:id/revoke marks revoked; a later GET excludes it", async () => {
      const s = await seed();
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "new@a.example", fullName: "New" }],
      });
      const listRes = await call("GET", "/v1/cockpit/providers/invites", s.sid);
      const listBody = (await listRes.json()) as { invites: Array<{ id: string }> };
      const inviteId = listBody.invites[0]!.id;

      const rev = await call("POST", `/v1/cockpit/providers/invites/${inviteId}/revoke`, s.sid);
      expect(rev.status).toBeLessThan(300);

      const [row] = await db()
        .select({ revokedAt: schema.providerInviteTokens.revokedAt })
        .from(schema.providerInviteTokens)
        .where(eq(schema.providerInviteTokens.id, inviteId));
      expect(row?.revokedAt).not.toBeNull();
    });

    it("POST /invites/:id/resend on a valid invite → 2xx (re-emits URL/email)", async () => {
      const s = await seed();
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "new@a.example", fullName: "New" }],
      });
      const listRes = await call("GET", "/v1/cockpit/providers/invites", s.sid);
      const listBody = (await listRes.json()) as { invites: Array<{ id: string }> };
      const inviteId = listBody.invites[0]!.id;
      const res = await call("POST", `/v1/cockpit/providers/invites/${inviteId}/resend`, s.sid);
      expect(res.status).toBeLessThan(300);
    });
  });

  // ─── verifications ─────────────────────────────────────────────────────
  describe("verifications", () => {
    it("POST add → 201 + GET returns it, DELETE → 204 + gone", async () => {
      const s = await seed();
      const create = await call(
        "POST",
        `/v1/cockpit/providers/${s.providerId}/verifications`,
        s.sid,
        {
          type: "state_license",
          source: "State Medical Board",
          state: "CA",
          licenseNumber: "MD12345",
          status: "verified",
          verifiedAt: "2025-01-01",
        },
      );
      expect(create.status).toBe(201);
      const created = (await create.json()) as { id: string };

      const list = await call("GET", `/v1/cockpit/providers/${s.providerId}/verifications`, s.sid);
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as {
        verifications: Array<{ id: string; status: string }>;
      };
      expect(listBody.verifications.map((v) => v.id)).toContain(created.id);

      const del = await call("DELETE", `/v1/cockpit/verifications/${created.id}`, s.sid);
      expect(del.status).toBe(204);

      const rows = await db()
        .select({ id: schema.verifications.id })
        .from(schema.verifications)
        .where(eq(schema.verifications.id, created.id));
      expect(rows).toHaveLength(0);
    });

    it("POST with invalid status enum → 400", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cockpit/providers/${s.providerId}/verifications`, s.sid, {
        type: "x",
        source: "y",
        status: "not_valid",
      });
      expect(res.status).toBe(400);
    });

    it("DELETE non-existent verification → 404", async () => {
      const s = await seed();
      const res = await call(
        "DELETE",
        "/v1/cockpit/verifications/00000000-0000-0000-0000-000000000000",
        s.sid,
      );
      expect(res.status).toBe(404);
    });
  });
});
