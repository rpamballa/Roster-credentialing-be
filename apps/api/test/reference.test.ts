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
const { issueReferenceToken, closeSessionStore } = await import("@cred/auth");
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
 * Reference form surface. Public — the responder isn't authenticated,
 * they hold a one-shot token emailed to them. Two invariants worth
 * guarding: the preview does NOT consume the token, and submit is
 * single-use (a second POST returns 400).
 */
describe("/reference/*", () => {
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

  async function seedReference(): Promise<{
    referenceId: string;
    caseId: string;
    workspaceId: string;
    token: string;
  }> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [provider] = await db()
      .insert(schema.providers)
      .values({ email: "p@a.example", firstName: "Ada", lastName: "Lovelace", userId: null })
      .returning({ id: schema.providers.id });
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
    const [cs] = await db()
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
    const [ref] = await db()
      .insert(schema.references)
      .values({
        workspaceId: ws!.id,
        caseId: cs!.id,
        name: "Referee Jones",
        relationship: "Attending",
        email: "referee@example.com",
        status: "sent",
      })
      .returning({ id: schema.references.id });
    const { token } = await issueReferenceToken({
      referenceId: ref!.id,
      workspaceId: ws!.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { referenceId: ref!.id, caseId: cs!.id, workspaceId: ws!.id, token };
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

  // ─── GET /reference/:token ─────────────────────────────────────────────
  describe("GET /reference/:token", () => {
    it("valid token → 200 + form context", async () => {
      const s = await seedReference();
      const res = await call("GET", `/reference/${s.token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        referenceName: string;
        providerFirstName: string;
        providerLastName: string;
        facilityName: string;
        workspaceName: string;
        specialty: string;
        questions: Array<{ id: string; kind: string }>;
      };
      expect(body.referenceName).toBe("Referee Jones");
      expect(body.providerFirstName).toBe("Ada");
      expect(body.providerLastName).toBe("Lovelace");
      expect(body.facilityName).toBe("Test Hospital");
      expect(body.workspaceName).toBe("Agency");
      expect(body.specialty).toBe("Emergency Medicine");
      // The form questions are a fixed contract with the FE — if this
      // shape drifts, the reference form breaks silently.
      expect(body.questions.map((q) => q.id)).toEqual([
        "worked_with_recent",
        "claims_or_discipline",
        "would_recommend",
        "notes",
        "attestation",
      ]);
    });

    it("invalid token → 400", async () => {
      const res = await call("GET", `/reference/${"x".repeat(64)}`);
      expect(res.status).toBe(400);
    });

    it("too-short token → 400", async () => {
      const res = await call("GET", "/reference/short");
      expect(res.status).toBe(400);
    });

    it("preview does NOT consume — can submit after previewing", async () => {
      const s = await seedReference();
      const preview = await call("GET", `/reference/${s.token}`);
      expect(preview.status).toBe(200);
      const submit = await call("POST", "/reference/submit", {
        token: s.token,
        answers: { worked_with_recent: true, notes: "solid" },
      });
      expect(submit.status).toBe(200);
    });
  });

  // ─── POST /reference/submit ─────────────────────────────────────────────
  describe("POST /reference/submit", () => {
    it("valid token + answers → 200, references row status=completed", async () => {
      const s = await seedReference();
      const res = await call("POST", "/reference/submit", {
        token: s.token,
        answers: { worked_with_recent: true, would_recommend: true, notes: "excellent" },
      });
      expect(res.status).toBe(200);

      const [row] = await db()
        .select({
          status: schema.references.status,
          respondedAt: schema.references.respondedAt,
          responseFields: schema.references.responseFields,
        })
        .from(schema.references)
        .where(eq(schema.references.id, s.referenceId))
        .limit(1);
      expect(row?.status).toBe("completed");
      expect(row?.respondedAt).not.toBeNull();
      expect(row?.responseFields).toMatchObject({
        worked_with_recent: true,
        notes: "excellent",
      });
    });

    it("second submit → 400 (token single-use)", async () => {
      const s = await seedReference();
      const first = await call("POST", "/reference/submit", {
        token: s.token,
        answers: { worked_with_recent: true },
      });
      expect(first.status).toBe(200);
      const second = await call("POST", "/reference/submit", {
        token: s.token,
        answers: { worked_with_recent: false },
      });
      expect(second.status).toBe(400);
    });

    it("writes both reference.responded and reference.completed audit events", async () => {
      const s = await seedReference();
      await call("POST", "/reference/submit", {
        token: s.token,
        answers: { worked_with_recent: true },
      });
      const actions = (
        await db()
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.targetEntityId, s.referenceId))
      ).map((a) => a.action);
      expect(actions).toContain("reference.responded");
      expect(actions).toContain("reference.completed");
    });

    it("bogus token → 400", async () => {
      const res = await call("POST", "/reference/submit", {
        token: "x".repeat(64),
        answers: {},
      });
      expect(res.status).toBe(400);
    });
  });
});
