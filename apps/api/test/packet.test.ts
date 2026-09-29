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
 * Packet endpoints — the pre-submit flow. `/submit` is covered by
 * stateMachine.test.ts. This file covers `assemble`, `preview`, and
 * `GET /packet` — the three that had no coverage.
 */
describe("packet endpoints (non-submit)", () => {
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
    caseId: string;
    facilityProfileId: string;
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
      .values({ email: "p@a.example", firstName: "P", lastName: "Q", userId: null })
      .returning({ id: schema.providers.id });
    const [facility] = await db()
      .insert(schema.facilities)
      .values({ name: "Test Hosp" })
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
        status: "ready_for_review",
      })
      .returning({ id: schema.cases.id });
    const sid = await createSession({
      userId: user!.id,
      email: "s@a.example",
      activeWorkspaceId: ws!.id,
    });
    return {
      userId: user!.id,
      workspaceId: ws!.id,
      caseId: cs!.id,
      facilityProfileId: profile!.id,
      sid,
    };
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

  // ─── GET /v1/cockpit/cases/:caseId/packet/preview ──────────────────────
  describe("GET /packet/preview", () => {
    it("case with no packet yet → 200 with fields array (empty is fine)", async () => {
      const s = await seed();
      const res = await call("GET", `/v1/cockpit/cases/${s.caseId}/packet/preview`, s.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fields: unknown[] };
      expect(Array.isArray(body.fields)).toBe(true);
    });

    it("unknown caseId → 404", async () => {
      const s = await seed();
      const res = await call(
        "GET",
        "/v1/cockpit/cases/00000000-0000-0000-0000-000000000000/packet/preview",
        s.sid,
      );
      expect(res.status).toBe(404);
    });

    it("no session → 401", async () => {
      const s = await seed();
      const res = await app.fetch(
        new Request(`http://localhost/v1/cockpit/cases/${s.caseId}/packet/preview`),
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /v1/cockpit/cases/:caseId/packet/assemble ────────────────────
  describe("POST /packet/assemble", () => {
    it("unknown caseId → 404", async () => {
      const s = await seed();
      const res = await call(
        "POST",
        "/v1/cockpit/cases/00000000-0000-0000-0000-000000000000/packet/assemble",
        s.sid,
      );
      expect(res.status).toBe(404);
    });

    it("no session → 401", async () => {
      const s = await seed();
      const res = await app.fetch(
        new Request(`http://localhost/v1/cockpit/cases/${s.caseId}/packet/assemble`, {
          method: "POST",
        }),
      );
      expect(res.status).toBe(401);
    });

    it("case with no facility profile → 4xx (not 200)", async () => {
      const s = await seed();
      // Sever the profile link.
      await db()
        .update(schema.cases)
        .set({ facilityProfileId: null })
        .where(eq(schema.cases.id, s.caseId));
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/packet/assemble`, s.sid);
      // assemblePacket throws PacketAssemblyError which maps 404 for
      // case_not_found and 409 for other codes. The internal check may
      // report either depending on how the null profile is spotted.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // ─── GET /v1/cockpit/cases/:caseId/packet ──────────────────────────────
  describe("GET /packet", () => {
    it("case with no packet row → 404", async () => {
      const s = await seed();
      const res = await call("GET", `/v1/cockpit/cases/${s.caseId}/packet`, s.sid);
      expect(res.status).toBe(404);
    });

    it("case WITH a packet row → 200 + signed downloadUrl + provenance", async () => {
      const s = await seed();
      const [pkt] = await db()
        .insert(schema.packets)
        .values({
          caseId: s.caseId,
          workspaceId: s.workspaceId,
          fileUri: `packets/${s.caseId}.pdf`,
          contentHash: "sha256:test",
          provenance: {
            modelVersions: { extractor: "v1" },
            documentIds: [],
            facilityProfileVersion: 1,
          },
        })
        .returning({ id: schema.packets.id });

      const res = await call("GET", `/v1/cockpit/cases/${s.caseId}/packet`, s.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        packetId: string;
        contentHash: string;
        downloadUrl: string;
        provenance: { modelVersions: Record<string, string> };
      };
      expect(body.packetId).toBe(pkt!.id);
      expect(body.contentHash).toBe("sha256:test");
      expect(body.downloadUrl).toContain("cred-dev");
      expect(body.provenance.modelVersions.extractor).toBe("v1");
    });

    it("no session → 401", async () => {
      const s = await seed();
      const res = await app.fetch(
        new Request(`http://localhost/v1/cockpit/cases/${s.caseId}/packet`),
      );
      expect(res.status).toBe(401);
    });
  });
});
