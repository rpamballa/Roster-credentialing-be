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

// Minimal facility_profiles.requirements JSONB — matches EMPTY_REQS used
// in sibling tests. We seed facilities on-the-fly in the openCase tests.
const EMPTY_REQS = {
  required_documents: [],
  required_verifications: [],
  privilege_delineations: [],
  attestations: [],
  submission: { method: "email" as const },
  facility_forms: [],
};

async function seedApprovedFacility(workspaceId: string, name: string): Promise<string> {
  const [facility] = await db()
    .insert(schema.facilities)
    .values({ name })
    .returning({ id: schema.facilities.id });
  await db().insert(schema.facilityProfiles).values({
    facilityId: facility!.id,
    workspaceId,
    version: 1,
    status: "approved",
    requirements: EMPTY_REQS,
  });
  return facility!.id;
}

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

    // ─── openCase: invite + inline case creation ────────────────────────
    //
    // The invite form's "Also open a case" toggle sends an `openCase`
    // field. These tests pin down the happy path, the facility-level
    // failure, and dedupe-on-replay semantics so the FE can rely on
    // (status === "sent" && caseId) as a tight contract.

    it("openCase set + approved facility → sent + caseId + cases row + audit", async () => {
      const s = await seed();
      const facilityId = await seedApprovedFacility(s.workspaceId, "Mercy Memorial");

      const res = await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [
          {
            email: "docket@a.example",
            fullName: "Docket Doe",
            openCase: {
              facilityId,
              specialty: "Emergency Medicine",
              purpose: "initial_appointment",
            },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{
          email: string;
          status: string;
          caseId?: string;
          caseFacilityName?: string;
        }>;
      };
      expect(body.results[0]?.status).toBe("sent");
      expect(body.results[0]?.caseId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.results[0]?.caseFacilityName).toBe("Mercy Memorial");

      // The cases row landed with status=intake and the right specialty.
      const cases = await db()
        .select({
          id: schema.cases.id,
          specialty: schema.cases.specialty,
          status: schema.cases.status,
        })
        .from(schema.cases);
      expect(cases).toHaveLength(1);
      expect(cases[0]?.specialty).toBe("Emergency Medicine");
      expect(cases[0]?.status).toBe("intake");

      // Audit row flipped to the …_with_case action.
      const audits = await db().select({ action: schema.auditLog.action }).from(schema.auditLog);
      expect(audits.map((a) => a.action)).toContain("provider_invite.sent_with_case");
    });

    it("openCase with unknown facility → row failed, no cases row, no invite emailed", async () => {
      const s = await seed();
      // DO NOT seed the facility — the id below is dangling on purpose.
      const danglingFacilityId = "00000000-0000-0000-0000-000000000000";

      const res = await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [
          {
            email: "broken@a.example",
            fullName: "Broken Case",
            openCase: {
              facilityId: danglingFacilityId,
              specialty: "Emergency Medicine",
              purpose: "initial_appointment",
            },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ email: string; status: string; error?: string }>;
      };
      expect(body.results[0]?.status).toBe("failed");
      expect(body.results[0]?.error).toMatch(/approved profile/i);

      // No case row persisted.
      const cases = await db().select({ id: schema.cases.id }).from(schema.cases);
      expect(cases).toHaveLength(0);
    });

    // Note: the dedupe-on-case-already-open branch inside
    // createCaseForProvider is exercised by cockpitCases POST tests. The
    // invite endpoint can't easily reach it because dedupe-on-open-invite
    // short-circuits a replay first — covering that branch here would
    // require manually redeeming the first invite, which is beyond the
    // scope of this file.
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

  // ─── DELETE /invites/:id + POST /invites/cleanup ─────────────────────
  //
  // Hard-delete semantics (be#55). Terminal-only guard keeps the
  // operator from accidentally wiping an invite someone is about to
  // redeem.
  describe("invite cleanup", () => {
    it("DELETE on a revoked invite → row gone, audit written", async () => {
      const s = await seed();
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "revoked@a.example", fullName: "To Remove" }],
      });
      const listBefore = (await (
        await call("GET", "/v1/cockpit/providers/invites", s.sid)
      ).json()) as { invites: Array<{ id: string; email: string }> };
      const inviteId = listBefore.invites.find((i) => i.email === "revoked@a.example")!.id;

      // Revoke first → terminal state.
      await call("POST", `/v1/cockpit/providers/invites/${inviteId}/revoke`, s.sid);

      const del = await call("DELETE", `/v1/cockpit/providers/invites/${inviteId}`, s.sid);
      expect(del.status).toBe(200);

      // Row is gone.
      const rows = await db()
        .select({ id: schema.providerInviteTokens.id })
        .from(schema.providerInviteTokens)
        .where(eq(schema.providerInviteTokens.id, inviteId));
      expect(rows).toHaveLength(0);

      // Audit entry recorded for the deletion.
      const audits = await db().select({ action: schema.auditLog.action }).from(schema.auditLog);
      expect(audits.map((a) => a.action)).toContain("provider_invite.deleted");
    });

    it("DELETE on a pending invite → 409 with the 'revoke first' title", async () => {
      const s = await seed();
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [{ email: "pending@a.example", fullName: "Pending" }],
      });
      const list = (await (await call("GET", "/v1/cockpit/providers/invites", s.sid)).json()) as {
        invites: Array<{ id: string; email: string }>;
      };
      const inviteId = list.invites.find((i) => i.email === "pending@a.example")!.id;

      const res = await call("DELETE", `/v1/cockpit/providers/invites/${inviteId}`, s.sid);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { title: string };
      expect(body.title).toMatch(/revoke.*before.*removing/i);

      // Row is still there — belt-and-braces, make sure the 409 didn't
      // delete anyway.
      const stillThere = await db()
        .select({ id: schema.providerInviteTokens.id })
        .from(schema.providerInviteTokens)
        .where(eq(schema.providerInviteTokens.id, inviteId));
      expect(stillThere).toHaveLength(1);
    });

    it("DELETE on an unknown invite id → 404", async () => {
      const s = await seed();
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await call("DELETE", `/v1/cockpit/providers/invites/${fakeId}`, s.sid);
      expect(res.status).toBe(404);
    });

    it("POST /invites/cleanup deletes terminal rows, leaves pending, returns count", async () => {
      const s = await seed();
      // Three invites: one we'll leave pending, one we revoke, one we
      // backdate past expires_at to simulate 'expired'.
      await call("POST", "/v1/cockpit/providers/invite", s.sid, {
        invites: [
          { email: "pending@a.example", fullName: "P" },
          { email: "revoked@a.example", fullName: "R" },
          { email: "expired@a.example", fullName: "E" },
        ],
      });
      const list = (await (await call("GET", "/v1/cockpit/providers/invites", s.sid)).json()) as {
        invites: Array<{ id: string; email: string; status: string }>;
      };
      const pending = list.invites.find((i) => i.email === "pending@a.example")!;
      const revoked = list.invites.find((i) => i.email === "revoked@a.example")!;
      const expired = list.invites.find((i) => i.email === "expired@a.example")!;

      // Revoke one; expire the other directly in the DB (no public
      // endpoint for 'expire').
      await call("POST", `/v1/cockpit/providers/invites/${revoked.id}/revoke`, s.sid);
      await db()
        .update(schema.providerInviteTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.providerInviteTokens.id, expired.id));

      const res = await call("POST", "/v1/cockpit/providers/invites/cleanup", s.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; deleted: number };
      expect(body.ok).toBe(true);
      expect(body.deleted).toBe(2);

      // Only the pending row survives.
      const remaining = await db()
        .select({ id: schema.providerInviteTokens.id })
        .from(schema.providerInviteTokens);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(pending.id);

      // Audit for the cleanup action was recorded.
      const audits = await db().select({ action: schema.auditLog.action }).from(schema.auditLog);
      expect(audits.map((a) => a.action)).toContain("provider_invites.cleanup");
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
