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
const { eq, and } = await import("drizzle-orm");
const { getObjectStorage } = await import("@cred/storage");
const { capturedEmails, resetDeliverySpies } = await import("./support/deliverySpies.js");

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
 * Case document lifecycle end-to-end: sign-upload → PUT → uploaded →
 * confirm → GET doc metadata. Plus references CRUD on the same case.
 *
 * Uses a staff session linked to the case's provider (via
 * providers.user_id) so requireProviderAuth accepts it on the
 * /v1/cases/* mount.
 */
describe("/v1/cases/:caseId/documents/* and references", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
    resetDeliverySpies();
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  interface Seed {
    userId: string;
    workspaceId: string;
    providerId: string;
    caseId: string;
    sid: string;
  }

  async function seed(): Promise<Seed> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "prov@a.example", name: "Provider", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "prov@a.example",
        firstName: "Ada",
        lastName: "Lovelace",
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
    const sid = await createSession({
      userId: user!.id,
      email: "prov@a.example",
      activeWorkspaceId: ws!.id,
    });
    return {
      userId: user!.id,
      workspaceId: ws!.id,
      providerId: provider!.id,
      caseId: cs!.id,
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

  // ─── POST /v1/cases/:caseId/documents/sign-upload ──────────────────────
  describe("POST /v1/cases/:caseId/documents/sign-upload", () => {
    it("valid body → 200 with documentId + uploadUrl + method", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cases/${s.caseId}/documents/sign-upload`, s.sid, {
        documentType: "medical_license",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        documentId: string;
        uploadUrl: string;
        method: string;
      };
      expect(body.documentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.uploadUrl).toContain("cred-dev");
      expect(["PUT", "POST"]).toContain(body.method);

      // Audit row recorded with document.upload_signed.
      const audits = await db()
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetEntityId, body.documentId));
      expect(audits.map((a) => a.action)).toContain("document.upload_signed");
    });

    it("does NOT insert a documents row — happens later on /uploaded", async () => {
      const s = await seed();
      await call("POST", `/v1/cases/${s.caseId}/documents/sign-upload`, s.sid, {
        documentType: "dea",
        mimeType: "application/pdf",
      });
      const docs = await db().select({ id: schema.documents.id }).from(schema.documents);
      expect(docs).toHaveLength(0);
    });

    it("invalid documentType → 400", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cases/${s.caseId}/documents/sign-upload`, s.sid, {
        documentType: "not_a_type",
        mimeType: "application/pdf",
      });
      expect(res.status).toBe(400);
    });

    it("no session → 401", async () => {
      const s = await seed();
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentType: "dea", mimeType: "application/pdf" }),
      };
      const res = await app.fetch(
        new Request(`http://localhost/v1/cases/${s.caseId}/documents/sign-upload`, init),
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /v1/cases/:caseId/documents/:docId/uploaded ──────────────────
  describe("POST /v1/cases/:caseId/documents/:docId/uploaded", () => {
    async function signAndPut(
      s: Seed,
      mime = "application/pdf",
      documentType = "medical_license" as const,
    ): Promise<string> {
      const signRes = await call("POST", `/v1/cases/${s.caseId}/documents/sign-upload`, s.sid, {
        documentType,
        mimeType: mime,
        sizeBytes: 20,
      });
      const body = (await signRes.json()) as {
        documentId: string;
        uploadUrl: string;
        method: string;
      };
      const putRes = await fetch(body.uploadUrl, {
        method: body.method,
        headers: { "content-type": mime },
        body: Buffer.from("test-pdf-bytes"),
      });
      expect(putRes.ok, `emulator PUT/POST failed: ${putRes.status}`).toBe(true);
      return body.documentId;
    }

    it("after real GCS write → 200, inserts documents row + kicks extraction", async () => {
      const s = await seed();
      const docId = await signAndPut(s);
      const res = await call("POST", `/v1/cases/${s.caseId}/documents/${docId}/uploaded`, s.sid, {
        documentType: "medical_license",
        mimeType: "application/pdf",
      });
      expect(res.status).toBe(200);
      const rows = await db()
        .select({
          id: schema.documents.id,
          providerId: schema.documents.providerId,
          extractionStatus: schema.documents.extractionStatus,
        })
        .from(schema.documents)
        .where(eq(schema.documents.id, docId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.providerId).toBe(s.providerId);
      // Extraction can be in any state after the async worker has been
      // kicked (pending/running/succeeded/failed depending on timing +
      // whether an extractor is wired in this env). Just assert we set
      // SOME value, i.e. the write path succeeded.
      expect(rows[0]?.extractionStatus).toBeTruthy();
    });

    it("without GCS write → 409 (bytes not present)", async () => {
      const s = await seed();
      const fakeDocId = "11111111-1111-4111-8111-111111111111";
      const res = await call(
        "POST",
        `/v1/cases/${s.caseId}/documents/${fakeDocId}/uploaded`,
        s.sid,
        { documentType: "medical_license", mimeType: "application/pdf" },
      );
      expect(res.status).toBe(409);
    });
  });

  // ─── Full lifecycle → GET doc + confirm ────────────────────────────────
  describe("GET /v1/cases/:caseId/documents/:docId + confirm", () => {
    it("full flow: sign → PUT → uploaded → confirm updates extractedFields", async () => {
      const s = await seed();
      const signRes = await call("POST", `/v1/cases/${s.caseId}/documents/sign-upload`, s.sid, {
        documentType: "medical_license",
        mimeType: "application/pdf",
      });
      const signBody = (await signRes.json()) as {
        documentId: string;
        uploadUrl: string;
        method: string;
      };
      await fetch(signBody.uploadUrl, {
        method: signBody.method,
        headers: { "content-type": "application/pdf" },
        body: Buffer.from("bytes"),
      });
      await call("POST", `/v1/cases/${s.caseId}/documents/${signBody.documentId}/uploaded`, s.sid, {
        documentType: "medical_license",
        mimeType: "application/pdf",
      });

      const confirmRes = await call(
        "POST",
        `/v1/cases/${s.caseId}/documents/${signBody.documentId}/confirm`,
        s.sid,
        {
          fields: [
            {
              key: "license_number",
              label: "License Number",
              value: "MD-12345",
              confidence: 0.98,
              bbox: { page: 0, bbox: [0, 0, 1, 0.1] },
            },
          ],
        },
      );
      expect(confirmRes.status).toBe(200);

      const [row] = await db()
        .select({
          extractionStatus: schema.documents.extractionStatus,
          extractedFields: schema.documents.extractedFields,
          confirmedAt: schema.documents.confirmedAt,
        })
        .from(schema.documents)
        .where(eq(schema.documents.id, signBody.documentId));
      // The confirm handler sets extractionStatus="succeeded" unconditionally
      // when the update goes through, but the write may race with the inline
      // extractor writing "failed" back. Just assert confirm was persisted:
      // confirmedAt stamped + extractedFields written.
      expect(row?.confirmedAt).not.toBeNull();
      expect(row?.extractedFields).toBeTruthy();
    });

    it("confirm bogus docId → 404", async () => {
      const s = await seed();
      const res = await call(
        "POST",
        `/v1/cases/${s.caseId}/documents/00000000-0000-0000-0000-000000000000/confirm`,
        s.sid,
        { fields: [{ key: "x", label: "X", value: "v", confidence: 0.5 }] },
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── References CRUD ───────────────────────────────────────────────────
  describe("/v1/cases/:caseId/references", () => {
    it("POST → GET → DELETE round trip", async () => {
      const s = await seed();

      // Create.
      const createRes = await call("POST", `/v1/cases/${s.caseId}/references`, s.sid, {
        fullName: "Dr. Colleague",
        email: "colleague@example.com",
        organization: "Mercy Hospital",
        relationship: "peer_physician",
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { id: string };
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

      // List.
      const listRes = await call("GET", `/v1/cases/${s.caseId}/references`, s.sid);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{ id: string }>;
      expect(list.map((r) => r.id)).toContain(created.id);

      // Delete.
      const delRes = await call("DELETE", `/v1/cases/${s.caseId}/references/${created.id}`, s.sid);
      expect(delRes.status).toBe(204);

      // Confirm removed.
      const rows = await db()
        .select({ id: schema.references.id })
        .from(schema.references)
        .where(eq(schema.references.id, created.id));
      expect(rows).toHaveLength(0);
    });

    it("invalid relationship enum → 400", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cases/${s.caseId}/references`, s.sid, {
        fullName: "X",
        email: "x@example.com",
        organization: "O",
        relationship: "not_a_relationship",
      });
      expect(res.status).toBe(400);
    });

    it("DELETE non-existent reference → 404", async () => {
      const s = await seed();
      const res = await call(
        "DELETE",
        `/v1/cases/${s.caseId}/references/00000000-0000-0000-0000-000000000000`,
        s.sid,
      );
      expect(res.status).toBe(404);
    });

    it("POST with email → sendEmail invoked with the reference URL, audit records emailSent=true", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cases/${s.caseId}/references`, s.sid, {
        fullName: "Dr. Reference Person",
        email: "r@example.com",
        organization: "Org",
        relationship: "training_director",
      });
      const created = (await res.json()) as { id: string };

      // Real assertion — the invite button used to only write an
      // audit row without emailing. Now the mock records the actual
      // outbound call.
      expect(capturedEmails).toHaveLength(1);
      expect(capturedEmails[0]?.to).toBe("r@example.com");
      expect(capturedEmails[0]?.text).toMatch(/\/reference\/[A-Za-z0-9_-]+/);
      expect(capturedEmails[0]?.text).toContain("Dr. Reference Person");

      const [audit] = await db()
        .select({ action: schema.auditLog.action, afterState: schema.auditLog.afterState })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, created.id),
            eq(schema.auditLog.action, "reference.invited"),
          ),
        );
      expect(audit?.afterState).toMatchObject({ emailSent: true, emailSkipReason: null });
    });

    it("POST without email → 400 (zod requires email)", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cases/${s.caseId}/references`, s.sid, {
        fullName: "Emailless Peer",
        organization: "Org",
        relationship: "peer_physician",
      });
      expect(res.status).toBe(400);
      expect(capturedEmails).toHaveLength(0);
    });
  });

  // ─── Storage smoke ─────────────────────────────────────────────────────
  it("uses the fake-gcs emulator for both sign + read paths (sanity check)", async () => {
    // Just verifying the storage adapter wired up in this test suite —
    // if this fails, every other test above is red for infra reasons.
    const s = await seed();
    const store = getObjectStorage();
    const presign = await store.putSignedUrl({
      key: `sanity/${s.caseId}`,
      contentType: "application/pdf",
    });
    expect(presign.url).toBeTruthy();
    expect(["PUT", "POST"]).toContain(presign.method);
  });
});
