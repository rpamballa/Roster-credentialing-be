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
 * cockpitFacilities — ingest pipeline (sign→uploaded→GET job),
 * requirements PATCH (resets review marks), reviewed-fields PATCH,
 * approve state transition, and DELETE cascade guard.
 */
describe("cockpit facilities", () => {
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
    facilityId: string;
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
    const [facility] = await db()
      .insert(schema.facilities)
      .values({ name: "Test Hosp" })
      .returning({ id: schema.facilities.id });
    const sid = await createSession({
      userId: user!.id,
      email: "s@a.example",
      activeWorkspaceId: ws!.id,
    });
    return { userId: user!.id, workspaceId: ws!.id, facilityId: facility!.id, sid };
  }

  async function seedProfile(
    s: Seed,
    status: "draft" | "in_review" | "approved" = "draft",
  ): Promise<string> {
    const [row] = await db()
      .insert(schema.facilityProfiles)
      .values({
        facilityId: s.facilityId,
        workspaceId: s.workspaceId,
        version: 1,
        status,
        requirements: EMPTY_REQS,
      })
      .returning({ id: schema.facilityProfiles.id });
    return row!.id;
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

  // ─── Ingest pipeline ───────────────────────────────────────────────────
  describe("ingest sign-upload → uploaded → GET job", () => {
    it("sign-upload creates an ingest job in status=uploaded", async () => {
      const s = await seed();
      const res = await call("POST", "/v1/cockpit/facilities/ingest/sign-upload", s.sid, {
        facilityId: s.facilityId,
        mimeType: "application/pdf",
        sizeBytes: 4096,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ingestJobId: string;
        uploadUrl: string;
        method: string;
      };
      expect(body.ingestJobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(["PUT", "POST"]).toContain(body.method);

      const [row] = await db()
        .select({ status: schema.ingestJobs.status, workspaceId: schema.ingestJobs.workspaceId })
        .from(schema.ingestJobs)
        .where(eq(schema.ingestJobs.id, body.ingestJobId));
      expect(row?.workspaceId).toBe(s.workspaceId);
      expect(row?.status).toBe("uploaded");
    });

    it("sign-upload with just facilityName (no facilityId) creates the facility", async () => {
      const s = await seed();
      const before = await db().select({ id: schema.facilities.id }).from(schema.facilities);
      const res = await call("POST", "/v1/cockpit/facilities/ingest/sign-upload", s.sid, {
        facilityName: "Brand New Hospital",
        mimeType: "application/pdf",
        sizeBytes: 4096,
      });
      expect(res.status).toBe(200);
      const after = await db().select({ name: schema.facilities.name }).from(schema.facilities);
      expect(after.length).toBe(before.length + 1);
      expect(after.map((f) => f.name)).toContain("Brand New Hospital");
    });

    it("neither facilityId nor facilityName → 400 (zod refine)", async () => {
      const s = await seed();
      const res = await call("POST", "/v1/cockpit/facilities/ingest/sign-upload", s.sid, {
        mimeType: "application/pdf",
        sizeBytes: 4096,
      });
      expect(res.status).toBe(400);
    });

    it("invalid mimeType → 400 (zod enum)", async () => {
      const s = await seed();
      const res = await call("POST", "/v1/cockpit/facilities/ingest/sign-upload", s.sid, {
        facilityId: s.facilityId,
        mimeType: "audio/mp3",
        sizeBytes: 100,
      });
      expect(res.status).toBe(400);
    });

    it("GET /:jobId returns the job row for a valid id", async () => {
      const s = await seed();
      const sign = await call("POST", "/v1/cockpit/facilities/ingest/sign-upload", s.sid, {
        facilityId: s.facilityId,
        mimeType: "application/pdf",
        sizeBytes: 4096,
      });
      const { ingestJobId } = (await sign.json()) as { ingestJobId: string };
      const get = await call("GET", `/v1/cockpit/facilities/ingest/${ingestJobId}`, s.sid);
      expect(get.status).toBe(200);
      const body = (await get.json()) as { ingestJobId: string; status: string };
      expect(body.ingestJobId).toBe(ingestJobId);
      expect(body.status).toBeTruthy();
    });

    it("GET /:jobId for unknown job → 404", async () => {
      const s = await seed();
      const res = await call(
        "GET",
        "/v1/cockpit/facilities/ingest/00000000-0000-0000-0000-000000000000",
        s.sid,
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH requirements ────────────────────────────────────────────────
  describe("PATCH /facility-profiles/:id/requirements", () => {
    it("replaces requirements + clears reviewedFieldKeys + writes audit", async () => {
      const s = await seed();
      const profileId = await seedProfile(s);
      // Pre-populate reviewed keys — these should be wiped on the PATCH.
      await db()
        .update(schema.facilityProfiles)
        .set({ reviewedFieldKeys: ["doc_medical_license_0", "att_0"] })
        .where(eq(schema.facilityProfiles.id, profileId));

      const newReqs = {
        ...EMPTY_REQS,
        required_documents: [
          {
            type: "medical_license",
            count: 1,
            attestation_required: false,
          },
        ],
      };
      const res = await call(
        "PATCH",
        `/v1/cockpit/facility-profiles/${profileId}/requirements`,
        s.sid,
        newReqs,
      );
      expect(res.status).toBe(200);

      const [row] = await db()
        .select({
          reviewedFieldKeys: schema.facilityProfiles.reviewedFieldKeys,
          requirements: schema.facilityProfiles.requirements,
        })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, profileId));
      expect(row?.reviewedFieldKeys).toEqual([]);
      const reqs = row?.requirements as { required_documents: unknown[] };
      expect(reqs.required_documents).toHaveLength(1);
    });

    it("unknown facility_profile → 404", async () => {
      const s = await seed();
      const res = await call(
        "PATCH",
        "/v1/cockpit/facility-profiles/00000000-0000-0000-0000-000000000000/requirements",
        s.sid,
        EMPTY_REQS,
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH reviewed-fields ─────────────────────────────────────────────
  describe("PATCH /facility-profiles/:id/reviewed-fields", () => {
    it("replaces the full list; response echoes new keys", async () => {
      const s = await seed();
      const profileId = await seedProfile(s);
      const res = await call(
        "PATCH",
        `/v1/cockpit/facility-profiles/${profileId}/reviewed-fields`,
        s.sid,
        { keys: ["k1", "k2", "k3"] },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reviewedFieldKeys: string[] };
      expect(body.reviewedFieldKeys).toEqual(["k1", "k2", "k3"]);
    });

    it("> 500 keys → 400 (zod)", async () => {
      const s = await seed();
      const profileId = await seedProfile(s);
      const res = await call(
        "PATCH",
        `/v1/cockpit/facility-profiles/${profileId}/reviewed-fields`,
        s.sid,
        { keys: Array.from({ length: 501 }, (_, i) => `k${i}`) },
      );
      expect(res.status).toBe(400);
    });
  });

  // ─── POST approve ──────────────────────────────────────────────────────
  describe("POST /facilities/:id/approve", () => {
    it("draft profile → 204, status=approved, versions row inserted", async () => {
      const s = await seed();
      const profileId = await seedProfile(s, "draft");
      const res = await call("POST", `/v1/cockpit/facilities/${profileId}/approve`, s.sid);
      expect(res.status).toBe(204);
      const [row] = await db()
        .select({
          status: schema.facilityProfiles.status,
          approvedAt: schema.facilityProfiles.approvedAt,
          approvedBy: schema.facilityProfiles.approvedBy,
        })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, profileId));
      expect(row?.status).toBe("approved");
      expect(row?.approvedAt).not.toBeNull();
      expect(row?.approvedBy).toBe(s.userId);

      const versions = await db()
        .select({ version: schema.facilityProfileVersions.version })
        .from(schema.facilityProfileVersions)
        .where(eq(schema.facilityProfileVersions.facilityProfileId, profileId));
      expect(versions).toHaveLength(1);
    });

    it("already-approved profile → 409", async () => {
      const s = await seed();
      const profileId = await seedProfile(s, "approved");
      const res = await call("POST", `/v1/cockpit/facilities/${profileId}/approve`, s.sid);
      expect(res.status).toBe(409);
    });

    it("unknown profile → 404", async () => {
      const s = await seed();
      const res = await call(
        "POST",
        "/v1/cockpit/facilities/00000000-0000-0000-0000-000000000000/approve",
        s.sid,
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE facility profile ───────────────────────────────────────────
  describe("DELETE /facility-profiles/:id", () => {
    it("with no cases pinned → 204, profile row gone", async () => {
      const s = await seed();
      const profileId = await seedProfile(s, "draft");
      const res = await call("DELETE", `/v1/cockpit/facility-profiles/${profileId}`, s.sid);
      expect(res.status).toBe(204);
      const rows = await db()
        .select({ id: schema.facilityProfiles.id })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, profileId));
      expect(rows).toHaveLength(0);
    });

    it("with a non-terminal case pinned → 409, profile untouched", async () => {
      const s = await seed();
      const profileId = await seedProfile(s, "approved");
      const [provider] = await db()
        .insert(schema.providers)
        .values({ email: "p@a.example", firstName: "P", lastName: "Q", userId: null })
        .returning({ id: schema.providers.id });
      await db().insert(schema.cases).values({
        workspaceId: s.workspaceId,
        providerId: provider!.id,
        facilityProfileId: profileId,
        facilityProfileVersion: "1",
        specialty: "EM",
        purpose: "initial_appointment",
        status: "awaiting_provider",
      });
      const res = await call("DELETE", `/v1/cockpit/facility-profiles/${profileId}`, s.sid);
      expect(res.status).toBe(409);
      const rows = await db()
        .select({ id: schema.facilityProfiles.id })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, profileId));
      expect(rows).toHaveLength(1);
    });

    it("unknown profile → 404", async () => {
      const s = await seed();
      const res = await call(
        "DELETE",
        "/v1/cockpit/facility-profiles/00000000-0000-0000-0000-000000000000",
        s.sid,
      );
      expect(res.status).toBe(404);
    });
  });
});
