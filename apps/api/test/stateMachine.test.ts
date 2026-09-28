import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Env before app imports — @cred/config reads at load.
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
const { and, eq } = await import("drizzle-orm");

// Requirements object with one required attestation, so packet/submit can
// exercise its attestation gate. Empty everywhere else.
const REQS_WITH_ATTESTATION = {
  required_documents: [],
  required_verifications: [],
  privilege_delineations: [],
  attestations: [
    {
      text: "I attest that all information is accurate.",
      signer_role: "provider" as const,
      format: "checkbox" as const,
    },
  ],
  submission: { method: "email" as const },
  facility_forms: [],
};

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
 * Case state-machine coverage.
 *
 * These endpoints all mutate `cases.status`; a wrong-state transition is a
 * silent data-integrity bug that ships and shows up as a stuck case a week
 * later. Each test asserts:
 *   1. Happy path — allowed status → transition applied
 *   2. Wrong state — 409 with the current status echoed
 *   3. Not found / cross-tenant — 404 or 401 as appropriate
 *
 * Also covers the packet/submit attestation gate, since a submission that
 * bypassed it would ship an incomplete packet to the hospital.
 */
describe("case state machine", () => {
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
    otherWorkspaceId: string;
    userId: string;
    otherUserId: string;
    providerId: string;
    caseId: string;
    otherWorkspaceCaseId: string;
    facilityProfileId: string;
  }

  async function seed(
    initialStatus: "awaiting_provider" | "ready_for_review" | "submitted" | "completed",
    requirements = REQS_WITH_ATTESTATION,
  ): Promise<Seed> {
    // Primary workspace + staff owner.
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency A", slug: "agency-a", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "staff@a.example", name: "Staff A", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });

    // A second workspace + staff — for cross-tenant isolation checks.
    const [otherWs] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency B", slug: "agency-b", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [otherUser] = await db()
      .insert(schema.users)
      .values({ email: "staff@b.example", name: "Staff B", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: otherUser!.id, workspaceId: otherWs!.id, role: "owner" });

    // Provider linked to workspace A user, so requireProviderAuth on
    // /v1/cases/* accepts A's staff session as-the-provider.
    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "staff@a.example",
        firstName: "Staff",
        lastName: "Provider",
        userId: user!.id,
      })
      .returning({ id: schema.providers.id });
    await db()
      .insert(schema.providerWorkspaceGrants)
      .values({ providerId: provider!.id, workspaceId: ws!.id, grantedBy: null });

    // Facility + profile in workspace A.
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
        requirements,
      })
      .returning({ id: schema.facilityProfiles.id });

    // The case at the requested initial status.
    const [cs] = await db()
      .insert(schema.cases)
      .values({
        workspaceId: ws!.id,
        providerId: provider!.id,
        facilityProfileId: profile!.id,
        facilityProfileVersion: "1",
        specialty: "Emergency Medicine",
        purpose: "initial_appointment",
        status: initialStatus,
        submittedAt:
          initialStatus === "submitted" || initialStatus === "completed" ? new Date() : null,
      })
      .returning({ id: schema.cases.id });

    // A case in workspace B for cross-tenant checks. Different provider.
    const [providerB] = await db()
      .insert(schema.providers)
      .values({
        email: "p@b.example",
        firstName: "Prov",
        lastName: "B",
        userId: null,
      })
      .returning({ id: schema.providers.id });
    const [facilityB] = await db()
      .insert(schema.facilities)
      .values({ name: "Other Hospital" })
      .returning({ id: schema.facilities.id });
    const [profileB] = await db()
      .insert(schema.facilityProfiles)
      .values({
        facilityId: facilityB!.id,
        workspaceId: otherWs!.id,
        version: 1,
        status: "approved",
        requirements: EMPTY_REQS,
      })
      .returning({ id: schema.facilityProfiles.id });
    const [csB] = await db()
      .insert(schema.cases)
      .values({
        workspaceId: otherWs!.id,
        providerId: providerB!.id,
        facilityProfileId: profileB!.id,
        facilityProfileVersion: "1",
        specialty: "Cardiology",
        purpose: "initial_appointment",
        status: "awaiting_provider",
      })
      .returning({ id: schema.cases.id });

    return {
      workspaceId: ws!.id,
      otherWorkspaceId: otherWs!.id,
      userId: user!.id,
      otherUserId: otherUser!.id,
      providerId: provider!.id,
      caseId: cs!.id,
      otherWorkspaceCaseId: csB!.id,
      facilityProfileId: profile!.id,
    };
  }

  async function staffSid(userId: string, email: string, workspaceId: string): Promise<string> {
    return await createSession({ userId, email, activeWorkspaceId: workspaceId });
  }

  async function call(
    method: string,
    path: string,
    cookie?: string,
    body?: unknown,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        ...(cookie ? { cookie: `cred_sid=${cookie}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return app.fetch(new Request(`http://localhost${path}`, init));
  }

  async function caseStatus(caseId: string): Promise<string | null> {
    const rows = await db()
      .select({ status: schema.cases.status })
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);
    return rows[0]?.status ?? null;
  }

  // ─── Provider self-mark-ready: POST /v1/cases/:caseId/ready ────────────
  describe("POST /v1/cases/:caseId/ready", () => {
    it("awaiting_provider → ready_for_review (200)", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cases/${s.caseId}/ready`, sid);
      expect(res.status).toBe(200);
      expect(await caseStatus(s.caseId)).toBe("ready_for_review");
    });

    it("wrong state → 409, status untouched", async () => {
      const s = await seed("submitted");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cases/${s.caseId}/ready`, sid);
      expect(res.status).toBe(409);
      expect(await caseStatus(s.caseId)).toBe("submitted");
    });

    // /v1/cases/* is safe from cross-tenant traversal even with
    // rolbypassrls=t because requireProviderAuth on this URL family
    // joins providers.user_id = auth.session.userId — staff B has no
    // provider link to the workspace-A provider, so the join returns
    // zero rows and the middleware 401s. The cockpit-family tests
    // below (requireStaffAuth + RLS-only isolation) do NOT get this
    // protection — see the `.fails` markers there.
    it("cross-tenant: staff B on workspace-A case → 401", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.otherUserId, "staff@b.example", s.otherWorkspaceId);
      const res = await call("POST", `/v1/cases/${s.caseId}/ready`, sid);
      expect(res.status).toBe(401);
      expect(await caseStatus(s.caseId)).toBe("awaiting_provider");
    });
  });

  // ─── Provider self-attest: POST /v1/cases/:caseId/attestation/sign ─────
  describe("POST /v1/cases/:caseId/attestation/sign", () => {
    it("inserts one completed attestation per required (idempotent)", async () => {
      const s = await seed("awaiting_provider", REQS_WITH_ATTESTATION);
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);

      const first = await call("POST", `/v1/cases/${s.caseId}/attestation/sign`, sid, {});
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { inserted: number; required: number };
      expect(firstBody.required).toBe(1);
      expect(firstBody.inserted).toBe(1);

      // Second call is a no-op — no duplicate rows.
      const second = await call("POST", `/v1/cases/${s.caseId}/attestation/sign`, sid, {});
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { inserted: number };
      expect(secondBody.inserted).toBe(0);

      const rows = await db()
        .select({ id: schema.attestations.id, status: schema.attestations.status })
        .from(schema.attestations)
        .where(eq(schema.attestations.caseId, s.caseId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("completed");
    });

    it("case with no facility profile → 409", async () => {
      const s = await seed("awaiting_provider");
      // Sever the profile link.
      await db()
        .update(schema.cases)
        .set({ facilityProfileId: null })
        .where(eq(schema.cases.id, s.caseId));
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cases/${s.caseId}/attestation/sign`, sid, {});
      expect(res.status).toBe(409);
    });
  });

  // ─── Cockpit: POST /v1/cockpit/cases/:id/mark-ready ────────────────────
  describe("POST /v1/cockpit/cases/:caseId/mark-ready", () => {
    it("awaiting_provider → ready_for_review (204)", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/mark-ready`, sid);
      expect(res.status).toBe(204);
      expect(await caseStatus(s.caseId)).toBe("ready_for_review");
    });

    it("submitted → 409, status untouched", async () => {
      const s = await seed("submitted");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/mark-ready`, sid);
      expect(res.status).toBe(409);
      expect(await caseStatus(s.caseId)).toBe("submitted");
    });

    // See the parallel /v1/cases test — same bug class, opposite handler
    // family. This handler filters by caseId only, so RLS-bypass makes
    // it cross-tenant traversable. Marked with `it.fails` until the fix.
    it.fails(
      "cross-tenant: staff B on workspace-A case → 404 (RLS invisibility) (KNOWN BUG)",
      async () => {
        const s = await seed("awaiting_provider");
        const sid = await staffSid(s.otherUserId, "staff@b.example", s.otherWorkspaceId);
        const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/mark-ready`, sid);
        expect(res.status).toBe(404);
        expect(await caseStatus(s.caseId)).toBe("awaiting_provider");
      },
    );
  });

  // ─── Cockpit: POST /v1/cockpit/cases/:id/complete ──────────────────────
  describe("POST /v1/cockpit/cases/:caseId/complete", () => {
    it("submitted → completed (204) + completedAt set", async () => {
      const s = await seed("submitted");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/complete`, sid);
      expect(res.status).toBe(204);
      const [row] = await db()
        .select({ status: schema.cases.status, completedAt: schema.cases.completedAt })
        .from(schema.cases)
        .where(eq(schema.cases.id, s.caseId))
        .limit(1);
      expect(row?.status).toBe("completed");
      expect(row?.completedAt).not.toBeNull();
    });

    it("awaiting_provider → 409 (must be submitted first)", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/complete`, sid);
      expect(res.status).toBe(409);
    });
  });

  // ─── Cockpit: POST /v1/cockpit/cases/:id/withdraw ──────────────────────
  describe("POST /v1/cockpit/cases/:caseId/withdraw", () => {
    it("in-flight → withdrawn (204), reason recorded on the event", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/withdraw`, sid, {
        reason: "provider dropped out",
      });
      expect(res.status).toBe(204);
      expect(await caseStatus(s.caseId)).toBe("withdrawn");
    });

    it("already-completed → 409 (terminal)", async () => {
      const s = await seed("completed");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/withdraw`, sid, {
        reason: "too late",
      });
      expect(res.status).toBe(409);
      expect(await caseStatus(s.caseId)).toBe("completed");
    });

    it("empty reason → 400 (zod)", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/withdraw`, sid, { reason: "" });
      expect(res.status).toBe(400);
    });
  });

  // ─── Cockpit: POST /v1/cockpit/cases/:id/escalate ──────────────────────
  describe("POST /v1/cockpit/cases/:caseId/escalate", () => {
    it("audit-only, does NOT change case.status", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/escalate`, sid, {
        reason: "compliance_question",
        details: "needs legal review",
      });
      expect(res.status).toBe(204);
      expect(await caseStatus(s.caseId)).toBe("awaiting_provider");

      const audits = await db()
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, s.caseId),
            eq(schema.auditLog.action, "case.escalated"),
          ),
        );
      expect(audits).toHaveLength(1);
    });

    it("invalid reason enum → 400", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/escalate`, sid, {
        reason: "not_a_valid_reason",
        details: "x",
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Cockpit: POST /v1/cockpit/cases/:id/request-reupload ──────────────
  describe("POST /v1/cockpit/cases/:caseId/request-reupload", () => {
    it("audit-only, does NOT change case.status", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/request-reupload`, sid, {
        requirementKey: "medical_license",
        reason: "expired scan",
      });
      expect(res.status).toBe(204);
      expect(await caseStatus(s.caseId)).toBe("awaiting_provider");
    });
  });

  // ─── Cockpit: POST /v1/cockpit/cases/:id/packet/submit ─────────────────
  // The terminal-most transition in the whole product. Guarding the
  // attestation gate here prevents shipping an incomplete packet.
  describe("POST /v1/cockpit/cases/:caseId/packet/submit", () => {
    async function seedPacket(
      caseId: string,
      workspaceId: string,
      opts: { submittedAt?: Date | null } = {},
    ): Promise<string> {
      const [pkt] = await db()
        .insert(schema.packets)
        .values({
          caseId,
          workspaceId,
          fileUri: `gs://cred-dev/packets/${caseId}.pdf`,
          contentHash: "sha256:test",
          provenance: { modelVersions: {}, documentIds: [], facilityProfileVersion: 1 },
          submittedAt: opts.submittedAt ?? null,
        })
        .returning({ id: schema.packets.id });
      return pkt!.id;
    }

    const VALID_CHECKLIST = {
      license_confirmed: true,
      dea_confirmed: true,
      board_cert_confirmed: true,
      attestation_signed: true,
    } as const;

    it("attestation-gate: pending attestation → 409, case NOT flipped", async () => {
      const s = await seed("ready_for_review", REQS_WITH_ATTESTATION);
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const packetId = await seedPacket(s.caseId, s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/packet/submit`, sid, {
        packetId,
        checklist: VALID_CHECKLIST,
        submissionMethod: "email",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("attestations_pending");
      expect(await caseStatus(s.caseId)).toBe("ready_for_review");
    });

    it("happy path: attestations complete → 200, case → submitted, submittedAt stamped", async () => {
      const s = await seed("ready_for_review", REQS_WITH_ATTESTATION);
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      // Complete the required attestation.
      await db()
        .insert(schema.attestations)
        .values({
          workspaceId: s.workspaceId,
          caseId: s.caseId,
          docusignEnvelopeId: `self:${crypto.randomUUID()}`,
          text: REQS_WITH_ATTESTATION.attestations[0]!.text,
          status: "completed",
          completedAt: new Date(),
        });
      const packetId = await seedPacket(s.caseId, s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/packet/submit`, sid, {
        packetId,
        checklist: VALID_CHECKLIST,
        submissionMethod: "email",
      });
      expect(res.status).toBe(200);
      const [row] = await db()
        .select({ status: schema.cases.status, submittedAt: schema.cases.submittedAt })
        .from(schema.cases)
        .where(eq(schema.cases.id, s.caseId))
        .limit(1);
      expect(row?.status).toBe("submitted");
      expect(row?.submittedAt).not.toBeNull();
    });

    it("already-submitted packet → 409", async () => {
      const s = await seed("submitted", EMPTY_REQS);
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const packetId = await seedPacket(s.caseId, s.workspaceId, { submittedAt: new Date() });
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/packet/submit`, sid, {
        packetId,
        checklist: VALID_CHECKLIST,
        submissionMethod: "email",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("already_submitted");
    });

    it("packet_id doesn't belong to this case → 404", async () => {
      const s = await seed("ready_for_review", EMPTY_REQS);
      const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/packet/submit`, sid, {
        packetId: "00000000-0000-0000-0000-000000000000",
        checklist: VALID_CHECKLIST,
        submissionMethod: "email",
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── Cross-tenant isolation — the invariant everything else assumes ────
  describe("cross-tenant isolation", () => {
    it("staff B cannot read a workspace-A case via GET /v1/cases/:id", async () => {
      const s = await seed("awaiting_provider");
      const sid = await staffSid(s.otherUserId, "staff@b.example", s.otherWorkspaceId);
      const res = await call("GET", `/v1/cases/${s.caseId}`, sid);
      // requireProviderAuth on /v1/cases/* refuses without a provider link.
      expect(res.status).toBe(401);
    });

    it.fails(
      "staff A cannot poke a workspace-B case via /v1/cockpit/cases/:id/mark-ready (KNOWN BUG)",
      async () => {
        const s = await seed("awaiting_provider");
        const sid = await staffSid(s.userId, "staff@a.example", s.workspaceId);
        const res = await call(
          "POST",
          `/v1/cockpit/cases/${s.otherWorkspaceCaseId}/mark-ready`,
          sid,
        );
        expect(res.status).toBe(404);
        // Case in B untouched.
        const rows = await db()
          .select({ status: schema.cases.status })
          .from(schema.cases)
          .where(eq(schema.cases.id, s.otherWorkspaceCaseId))
          .limit(1);
        expect(rows[0]?.status).toBe("awaiting_provider");
      },
    );
  });
});
