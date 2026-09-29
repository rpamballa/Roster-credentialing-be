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
const { eq, and } = await import("drizzle-orm");
const { capturedEmails, capturedSms, capturedTickets, resetDeliverySpies } = await import(
  "./support/deliverySpies.js"
);

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
 * Cockpit case actions (the ones NOT covered by stateMachine.test.ts):
 *   - POST /v1/cockpit/cases — creation, incl. 422 branches
 *   - POST /v1/cockpit/cases/:id/nudge — audit-only
 *   - POST /v1/cockpit/bulk-nudge — audit-per-caseId
 *   - Case notes CRUD (GET / POST / DELETE) — only-author-can-delete
 *   - GET /v1/cockpit/specialists (list workspace staff)
 *   - PATCH /v1/cockpit/cases/:id/specialist — reassignment
 */
describe("cockpit case actions — non-state-machine mutations", () => {
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
    otherUserId: string;
    workspaceId: string;
    providerId: string;
    facilityId: string;
    facilityProfileId: string;
    caseId: string;
    sid: string;
    otherSid: string;
  }

  async function seed(): Promise<Seed> {
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Agency", slug: "agency", type: "agency" })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({ email: "s1@a.example", name: "Staff One", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    const [other] = await db()
      .insert(schema.users)
      .values({ email: "s2@a.example", name: "Staff Two", emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values([
        { userId: user!.id, workspaceId: ws!.id, role: "owner" },
        { userId: other!.id, workspaceId: ws!.id, role: "specialist" },
      ]);
    const [provider] = await db()
      .insert(schema.providers)
      .values({
        email: "p@a.example",
        firstName: "Ada",
        lastName: "Lovelace",
        userId: null,
      })
      .returning({ id: schema.providers.id });
    await db()
      .insert(schema.providerWorkspaceGrants)
      .values({ providerId: provider!.id, workspaceId: ws!.id, grantedBy: user!.id });
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
        specialty: "EM",
        purpose: "initial_appointment",
        status: "awaiting_provider",
        assignedSpecialistId: user!.id,
      })
      .returning({ id: schema.cases.id });
    const sid = await createSession({
      userId: user!.id,
      email: "s1@a.example",
      activeWorkspaceId: ws!.id,
    });
    const otherSid = await createSession({
      userId: other!.id,
      email: "s2@a.example",
      activeWorkspaceId: ws!.id,
    });
    return {
      userId: user!.id,
      otherUserId: other!.id,
      workspaceId: ws!.id,
      providerId: provider!.id,
      facilityId: facility!.id,
      facilityProfileId: profile!.id,
      caseId: cs!.id,
      sid,
      otherSid,
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

  // ─── POST /v1/cockpit/cases ────────────────────────────────────────────
  describe("POST /v1/cockpit/cases", () => {
    it("happy path → creates case in intake, records status event + audit", async () => {
      const s = await seed();
      // Add a second provider for the create to reference, so the pre-existing
      // "awaiting_provider" case for provider #1 doesn't collide.
      const [p2] = await db()
        .insert(schema.providers)
        .values({ email: "p2@a.example", firstName: "B", lastName: "C", userId: null })
        .returning({ id: schema.providers.id });
      await db()
        .insert(schema.providerWorkspaceGrants)
        .values({ providerId: p2!.id, workspaceId: s.workspaceId, grantedBy: s.userId });

      const res = await call("POST", "/v1/cockpit/cases", s.sid, {
        providerId: p2!.id,
        facilityId: s.facilityId,
        specialty: "Cardiology",
        purpose: "initial_appointment",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { caseId: string };
      expect(body.caseId).toMatch(/^[0-9a-f-]{36}$/);

      // Case row exists in intake.
      const [row] = await db()
        .select({
          status: schema.cases.status,
          assignedSpecialistId: schema.cases.assignedSpecialistId,
        })
        .from(schema.cases)
        .where(eq(schema.cases.id, body.caseId));
      expect(row?.status).toBe("intake");
      expect(row?.assignedSpecialistId).toBe(s.userId);

      // Audit row.
      const audits = await db()
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetEntityId, body.caseId));
      expect(audits.map((a) => a.action)).toContain("case.created");
    });

    it("provider not in workspace → 422", async () => {
      const s = await seed();
      const [outsider] = await db()
        .insert(schema.providers)
        .values({ email: "out@a.example", firstName: "X", lastName: "Y", userId: null })
        .returning({ id: schema.providers.id });
      const res = await call("POST", "/v1/cockpit/cases", s.sid, {
        providerId: outsider!.id,
        facilityId: s.facilityId,
        specialty: "Neurology",
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("provider-not-in-workspace");
    });

    it("facility has no approved profile → 422", async () => {
      const s = await seed();
      const [otherFac] = await db()
        .insert(schema.facilities)
        .values({ name: "Other Hosp" })
        .returning({ id: schema.facilities.id });
      const res = await call("POST", "/v1/cockpit/cases", s.sid, {
        providerId: s.providerId,
        facilityId: otherFac!.id,
        specialty: "EM",
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("no-approved-facility-profile");
    });

    it("open case already exists → 409 with existing caseId", async () => {
      const s = await seed();
      // seed already made an awaiting_provider case for (provider, facility_profile).
      const res = await call("POST", "/v1/cockpit/cases", s.sid, {
        providerId: s.providerId,
        facilityId: s.facilityId,
        specialty: "EM",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type: string; caseId: string };
      expect(body.type).toContain("already-open");
      expect(body.caseId).toBe(s.caseId);
    });

    it("bad targetSubmissionDate format → 400 (zod regex)", async () => {
      const s = await seed();
      const res = await call("POST", "/v1/cockpit/cases", s.sid, {
        providerId: s.providerId,
        facilityId: s.facilityId,
        specialty: "EM",
        targetSubmissionDate: "not-a-date",
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /v1/cockpit/cases/:id/nudge ──────────────────────────────────
  describe("POST /v1/cockpit/cases/:id/nudge", () => {
    it("email channel: sendEmail is called with the provider address (real transport assertion)", async () => {
      const s = await seed();
      // Give the seeded provider an email address so delivery has a
      // recipient.
      await db()
        .update(schema.providers)
        .set({ email: "provider@example.com" })
        .where(eq(schema.providers.id, s.providerId));

      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/nudge`, s.sid, {
        channel: "email",
        message: "Reminder!",
      });
      expect(res.status).toBe(204);

      // Real assertion — the sendEmail mock in setupMocks.ts captures
      // every call. If the handler stopped at the audit row (the old
      // dead-code shape), this array would be empty.
      expect(capturedEmails).toHaveLength(1);
      expect(capturedEmails[0]?.to).toBe("provider@example.com");
      expect(capturedEmails[0]?.text).toContain("Reminder!");
      expect(capturedSms).toHaveLength(0);
    });

    it("email channel: no provider email → sendEmail is NOT called and audit records the skip", async () => {
      const s = await seed();
      // seed() creates provider with email 'p@a.example' — wipe it.
      await db()
        .update(schema.providers)
        .set({ email: null })
        .where(eq(schema.providers.id, s.providerId));
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/nudge`, s.sid, {
        channel: "email",
        message: "x",
      });
      expect(res.status).toBe(204);

      expect(capturedEmails).toHaveLength(0);

      const [row] = await db()
        .select({ afterState: schema.auditLog.afterState })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, s.caseId),
            eq(schema.auditLog.action, "case.nudge_sent"),
          ),
        );
      expect(row?.afterState).toMatchObject({
        channel: "email",
        emailSent: false,
        skipped: ["email:no_recipient"],
      });
    });

    it("sms_and_email: sendEmail AND sendSms are both invoked with the provider contacts", async () => {
      const s = await seed();
      await db()
        .update(schema.providers)
        .set({ email: "provider@example.com", phone: "+15551234567" })
        .where(eq(schema.providers.id, s.providerId));
      await call("POST", `/v1/cockpit/cases/${s.caseId}/nudge`, s.sid, {
        channel: "sms_and_email",
        message: "both channels",
      });

      expect(capturedEmails).toHaveLength(1);
      expect(capturedEmails[0]?.to).toBe("provider@example.com");
      expect(capturedSms).toHaveLength(1);
      expect(capturedSms[0]?.to).toBe("+15551234567");
      expect(capturedSms[0]?.body).toContain("both channels");
    });

    it("invalid channel → 400", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/nudge`, s.sid, {
        channel: "carrier_pigeon",
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /v1/cockpit/bulk-nudge ───────────────────────────────────────
  describe("POST /v1/cockpit/bulk-nudge", () => {
    it("emits one audit row per caseId, 200 with count", async () => {
      const s = await seed();
      // Two more cases so we can nudge in bulk.
      const [p2] = await db()
        .insert(schema.providers)
        .values({ email: "p2@a.example", firstName: "B", lastName: "C", userId: null })
        .returning({ id: schema.providers.id });
      await db()
        .insert(schema.providerWorkspaceGrants)
        .values({ providerId: p2!.id, workspaceId: s.workspaceId, grantedBy: s.userId });
      const [cs2] = await db()
        .insert(schema.cases)
        .values({
          workspaceId: s.workspaceId,
          providerId: p2!.id,
          facilityProfileId: s.facilityProfileId,
          facilityProfileVersion: "1",
          specialty: "EM",
          purpose: "initial_appointment",
          status: "awaiting_provider",
        })
        .returning({ id: schema.cases.id });

      const res = await call("POST", "/v1/cockpit/bulk-nudge", s.sid, {
        caseIds: [s.caseId, cs2!.id],
        message: "bulk!",
      });
      expect(res.status).toBe(204);

      // Emits ONE case.bulk_nudge_sent audit row with dispatchedCount=2,
      // not one per case.
      const audits = await db()
        .select({ action: schema.auditLog.action, afterState: schema.auditLog.afterState })
        .from(schema.auditLog);
      const bulkRow = audits.find((a) => a.action === "case.bulk_nudge_sent");
      expect(bulkRow).toBeTruthy();
      expect(bulkRow?.afterState).toMatchObject({ requestedCount: 2, dispatchedCount: 2 });
    });
  });

  // ─── POST /v1/cockpit/cases/:id/escalate ────────────────────────────
  describe("POST /v1/cockpit/cases/:id/escalate", () => {
    it("fans out a support ticket to notifySupportTicket (Slack + Sheet)", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/escalate`, s.sid, {
        reason: "facility_mismatch",
        details: "Facility requires MD but provider is DO — need policy call.",
      });
      expect(res.status).toBe(204);

      // Real assertion — the handler used to only audit. Now the
      // notifySupportTicket mock in setupMocks.ts records what would
      // have gone to Slack.
      expect(capturedTickets).toHaveLength(1);
      expect(capturedTickets[0]).toMatchObject({
        severity: "bug",
        caseId: s.caseId,
        subject: expect.stringContaining("facility_mismatch"),
        body: expect.stringContaining("Facility requires MD"),
      });
      expect(capturedTickets[0]?.workspace).toBe("Agency");
      expect(capturedTickets[0]?.userEmail).toBe("s1@a.example");

      // Audit row also references the ticketId so the two records
      // can be joined post-hoc.
      const [row] = await db()
        .select({ afterState: schema.auditLog.afterState })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, s.caseId),
            eq(schema.auditLog.action, "case.escalated"),
          ),
        );
      expect(row?.afterState).toMatchObject({
        reason: "facility_mismatch",
        ticketId: expect.stringMatching(/^esc_/),
      });
    });

    it("bad reason enum → 400 and no ticket sent", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/escalate`, s.sid, {
        reason: "aliens",
        details: "beep boop",
      });
      expect(res.status).toBe(400);
      expect(capturedTickets).toHaveLength(0);
    });

    it("missing details → 400 (required by zod)", async () => {
      const s = await seed();
      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/escalate`, s.sid, {
        reason: "other",
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /v1/cockpit/cases/:id/request-reupload ────────────────────
  describe("POST /v1/cockpit/cases/:id/request-reupload", () => {
    it("emails + SMS the provider when both contacts exist", async () => {
      const s = await seed();
      await db()
        .update(schema.providers)
        .set({ email: "provider@example.com", phone: "+15550001111" })
        .where(eq(schema.providers.id, s.providerId));

      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/request-reupload`, s.sid, {
        requirementKey: "state_license.CA",
        reason: "The scan on file is expired; upload the current one.",
      });
      expect(res.status).toBe(204);

      expect(capturedEmails).toHaveLength(1);
      expect(capturedEmails[0]?.to).toBe("provider@example.com");
      expect(capturedEmails[0]?.subject).toContain("state_license.CA");
      expect(capturedEmails[0]?.text).toContain("The scan on file is expired");

      expect(capturedSms).toHaveLength(1);
      expect(capturedSms[0]?.to).toBe("+15550001111");
      expect(capturedSms[0]?.body).toContain("state_license.CA");

      const [row] = await db()
        .select({ afterState: schema.auditLog.afterState })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, s.caseId),
            eq(schema.auditLog.action, "case.reupload_requested"),
          ),
        );
      expect(row?.afterState).toMatchObject({
        requirementKey: "state_license.CA",
        emailSent: true,
        smsSent: true,
      });
    });

    it("no email + no phone on provider → skips both, audit records the reasons", async () => {
      const s = await seed();
      await db()
        .update(schema.providers)
        .set({ email: null, phone: null })
        .where(eq(schema.providers.id, s.providerId));

      const res = await call("POST", `/v1/cockpit/cases/${s.caseId}/request-reupload`, s.sid, {
        requirementKey: "attestation.opioid_stewardship",
        reason: "Missing.",
      });
      expect(res.status).toBe(204);
      expect(capturedEmails).toHaveLength(0);
      expect(capturedSms).toHaveLength(0);

      const [row] = await db()
        .select({ afterState: schema.auditLog.afterState })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, s.caseId),
            eq(schema.auditLog.action, "case.reupload_requested"),
          ),
        );
      expect(row?.afterState).toMatchObject({
        emailSent: false,
        smsSent: false,
        skipped: ["no_email_recipient", "no_sms_recipient"],
      });
    });

    it("unknown case → 404, no email sent", async () => {
      const s = await seed();
      const res = await call(
        "POST",
        `/v1/cockpit/cases/00000000-0000-0000-0000-000000000000/request-reupload`,
        s.sid,
        { requirementKey: "x", reason: "y" },
      );
      expect(res.status).toBe(404);
      expect(capturedEmails).toHaveLength(0);
    });
  });

  // ─── POST /v1/cockpit/cases/:id/references/:refId/resend ─────────────
  describe("POST /v1/cockpit/cases/:caseId/references/:refId/resend", () => {
    async function seedReference(s: Seed, email: string | null): Promise<{ referenceId: string }> {
      const [ref] = await db()
        .insert(schema.references)
        .values({
          workspaceId: s.workspaceId,
          caseId: s.caseId,
          name: "Referee Jones",
          relationship: "peer_physician",
          email,
          status: "sent",
        })
        .returning({ id: schema.references.id });
      return { referenceId: ref!.id };
    }

    it("reference has email → sendEmail called with the /reference/${token} URL", async () => {
      const s = await seed();
      const { referenceId } = await seedReference(s, "referee@example.com");

      const res = await call(
        "POST",
        `/v1/cockpit/cases/${s.caseId}/references/${referenceId}/resend`,
        s.sid,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; emailSent: boolean };
      expect(body.url).toMatch(/\/reference\/[A-Za-z0-9_-]+/);
      expect(body.emailSent).toBe(true);

      expect(capturedEmails).toHaveLength(1);
      expect(capturedEmails[0]?.to).toBe("referee@example.com");
      expect(capturedEmails[0]?.text).toContain(body.url);
    });

    it("reference has no email → sendEmail NOT called, audit records no_recipient", async () => {
      const s = await seed();
      const { referenceId } = await seedReference(s, null);
      const res = await call(
        "POST",
        `/v1/cockpit/cases/${s.caseId}/references/${referenceId}/resend`,
        s.sid,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { emailSent: boolean };
      expect(body.emailSent).toBe(false);
      expect(capturedEmails).toHaveLength(0);

      const [row] = await db()
        .select({ afterState: schema.auditLog.afterState })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetEntityId, referenceId),
            eq(schema.auditLog.action, "reference.resent"),
          ),
        );
      expect(row?.afterState).toMatchObject({
        emailSent: false,
        emailSkipReason: "no_recipient",
      });
    });

    it("unknown reference → 404, no email", async () => {
      const s = await seed();
      const res = await call(
        "POST",
        `/v1/cockpit/cases/${s.caseId}/references/00000000-0000-0000-0000-000000000000/resend`,
        s.sid,
      );
      expect(res.status).toBe(404);
      expect(capturedEmails).toHaveLength(0);
    });
  });

  // ─── Notes CRUD ────────────────────────────────────────────────────────
  describe("case notes", () => {
    it("GET → 200 with empty list, then POST → 201, then GET has it", async () => {
      const s = await seed();
      const empty = await call("GET", `/v1/cockpit/cases/${s.caseId}/notes`, s.sid);
      expect(empty.status).toBe(200);
      const emptyBody = (await empty.json()) as { notes: unknown[] };
      expect(emptyBody.notes).toEqual([]);

      const create = await call("POST", `/v1/cockpit/cases/${s.caseId}/notes`, s.sid, {
        body: "First note.",
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as { id: string };

      const list = await call("GET", `/v1/cockpit/cases/${s.caseId}/notes`, s.sid);
      const listBody = (await list.json()) as {
        notes: Array<{ id: string; body: string; author: { name: string } }>;
      };
      expect(listBody.notes).toHaveLength(1);
      expect(listBody.notes[0]?.id).toBe(created.id);
      expect(listBody.notes[0]?.body).toBe("First note.");
      expect(listBody.notes[0]?.author?.name).toBe("Staff One");
    });

    it("DELETE by author → 204 + soft-deleted (not returned by GET)", async () => {
      const s = await seed();
      const create = await call("POST", `/v1/cockpit/cases/${s.caseId}/notes`, s.sid, {
        body: "note",
      });
      const { id } = (await create.json()) as { id: string };
      const del = await call("DELETE", `/v1/cockpit/cases/${s.caseId}/notes/${id}`, s.sid);
      expect(del.status).toBe(204);
      const list = await call("GET", `/v1/cockpit/cases/${s.caseId}/notes`, s.sid);
      const body = (await list.json()) as { notes: unknown[] };
      expect(body.notes).toEqual([]);
    });

    it("DELETE by non-author staff → 403 (only author can delete)", async () => {
      const s = await seed();
      const create = await call("POST", `/v1/cockpit/cases/${s.caseId}/notes`, s.sid, {
        body: "authored by s1",
      });
      const { id } = (await create.json()) as { id: string };
      const del = await call("DELETE", `/v1/cockpit/cases/${s.caseId}/notes/${id}`, s.otherSid);
      expect(del.status).toBe(403);
    });

    it("DELETE non-existent note → 404", async () => {
      const s = await seed();
      const res = await call(
        "DELETE",
        `/v1/cockpit/cases/${s.caseId}/notes/00000000-0000-0000-0000-000000000000`,
        s.sid,
      );
      expect(res.status).toBe(404);
    });
  });

  // ─── GET /v1/cockpit/specialists + PATCH specialist ────────────────────
  describe("specialist reassignment", () => {
    it("GET /v1/cockpit/specialists returns workspace staff", async () => {
      const s = await seed();
      const res = await call("GET", "/v1/cockpit/specialists", s.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { specialists: Array<{ email: string }> };
      const emails = body.specialists.map((x) => x.email);
      expect(emails).toContain("s1@a.example");
      expect(emails).toContain("s2@a.example");
    });

    it("PATCH /:id/specialist → 2xx, updates assignedSpecialistId", async () => {
      const s = await seed();
      const res = await call("PATCH", `/v1/cockpit/cases/${s.caseId}/specialist`, s.sid, {
        assignedSpecialistId: s.otherUserId,
      });
      expect(res.status).toBeLessThan(300);
      const [row] = await db()
        .select({ assignedSpecialistId: schema.cases.assignedSpecialistId })
        .from(schema.cases)
        .where(eq(schema.cases.id, s.caseId));
      expect(row?.assignedSpecialistId).toBe(s.otherUserId);
    });

    it("PATCH /:id/specialist with null clears assignment", async () => {
      const s = await seed();
      const res = await call("PATCH", `/v1/cockpit/cases/${s.caseId}/specialist`, s.sid, {
        assignedSpecialistId: null,
      });
      expect(res.status).toBeLessThan(300);
      const [row] = await db()
        .select({ assignedSpecialistId: schema.cases.assignedSpecialistId })
        .from(schema.cases)
        .where(eq(schema.cases.id, s.caseId));
      expect(row?.assignedSpecialistId).toBeNull();
    });
  });

  // ─── GET /v1/cockpit/cases/new/lookups ─────────────────────────────────
  it("GET /v1/cockpit/cases/new/lookups returns providers + approved facilities", async () => {
    const s = await seed();
    const res = await call("GET", "/v1/cockpit/cases/new/lookups", s.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string }>;
      facilities: Array<{ id: string }>;
    };
    expect(body.providers.map((p) => p.id)).toContain(s.providerId);
    expect(body.facilities.map((f) => f.id)).toContain(s.facilityId);
  });
});
