import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Signal needs its two gates flipped on for the service-wide check in
// the kill-switch middleware to let the route through. One of the
// test cases turns it OFF to exercise the 404 path; most flip it on.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";
process.env.API_PUBLIC_URL = "http://localhost:3001";
process.env.WEB_PUBLIC_URL = "http://localhost:3000";
process.env.SIGNAL_SERVICES_ENABLED = "true";

const { ensureSchema } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { buildApp } = await import("../src/app.js");
const { createSession, closeSessionStore } = await import("@cred/auth");
const { resetEnvForTesting } = await import("@cred/config");
const { db, schema, closeDb } = await import("@cred/db");
const { recordLineage } = await import("@cred/db/signal");
const { rankJobCandidates } = await import("@cred/signal-match");
const { applyOverridesToWeights } = await import("@cred/signal-learn");
const { eq, sql: drizzleSql } = await import("drizzle-orm");

// Signal creates its own `signal_*` rows; they cascade off workspaces
// so a workspace truncate wipes them. We include the few non-cascading
// anchors by name for safety against future schema drift.
async function clearAll(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      TRUNCATE
        signal_weights,
        signal_overrides,
        signal_rankings,
        signal_extracts,
        signal_conversations,
        signal_credentials,
        signal_source_lineage,
        signal_jobs,
        signal_providers,
        audit_log,
        memberships,
        workspaces,
        users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface WorkspaceSeed {
  userId: string;
  workspaceId: string;
  sid: string;
  // Three Signal providers with different credential mixes so the
  // ranker has something to differentiate — Alice has everything on
  // file, Bob is blocked on a new license, Charlie is sub-specialty
  // mismatched.
  aliceId: string;
  bobId: string;
  charlieId: string;
  jobId: string;
}

async function seedWorkspace(overrides: {
  slug: string;
  signalEnabled: boolean;
}): Promise<WorkspaceSeed> {
  const [ws] = await db()
    .insert(schema.workspaces)
    .values({
      name: `Agency ${overrides.slug}`,
      slug: overrides.slug,
      type: "agency",
      signalEnabled: overrides.signalEnabled,
    })
    .returning({ id: schema.workspaces.id });
  const [user] = await db()
    .insert(schema.users)
    .values({
      email: `staff@${overrides.slug}.example`,
      name: `Staff ${overrides.slug}`,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  await db()
    .insert(schema.memberships)
    .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });

  const sid = await createSession({
    userId: user!.id,
    email: `staff@${overrides.slug}.example`,
    activeWorkspaceId: ws!.id,
  });

  // Alice — all credentials active, sub-specialty matches.
  const [alice] = await db()
    .insert(schema.signalProviders)
    .values({
      workspaceId: ws!.id,
      name: "Alice Anesthesia",
      specialties: ["cardiac"],
      regionPrefs: ["NE"],
    })
    .returning();
  await db()
    .insert(schema.signalCredentials)
    .values([
      {
        workspaceId: ws!.id,
        providerId: alice!.id,
        type: "state_license",
        state: "MA",
        status: "active",
      },
      { workspaceId: ws!.id, providerId: alice!.id, type: "dea", status: "active" },
      {
        workspaceId: ws!.id,
        providerId: alice!.id,
        type: "state_csr",
        state: "MA",
        status: "active",
      },
      { workspaceId: ws!.id, providerId: alice!.id, type: "board_cert", status: "certified" },
      { workspaceId: ws!.id, providerId: alice!.id, type: "acls", status: "active" },
      { workspaceId: ws!.id, providerId: alice!.id, type: "immunizations", status: "complete" },
      { workspaceId: ws!.id, providerId: alice!.id, type: "background_check", status: "clear" },
      { workspaceId: ws!.id, providerId: alice!.id, type: "drug_screen", status: "clear" },
    ]);

  // Bob — missing state license. Will need ~90 days to get one, so a
  // tight need-date will drop him on the hard filter.
  const [bob] = await db()
    .insert(schema.signalProviders)
    .values({
      workspaceId: ws!.id,
      name: "Bob Backfill",
      specialties: ["cardiac"],
      regionPrefs: ["NE"],
    })
    .returning();
  await db()
    .insert(schema.signalCredentials)
    .values([
      // No state_license in MA — forces the license-lane projection.
      { workspaceId: ws!.id, providerId: bob!.id, type: "dea", status: "active" },
      {
        workspaceId: ws!.id,
        providerId: bob!.id,
        type: "state_csr",
        state: "MA",
        status: "active",
      },
      { workspaceId: ws!.id, providerId: bob!.id, type: "board_cert", status: "certified" },
      { workspaceId: ws!.id, providerId: bob!.id, type: "acls", status: "active" },
      { workspaceId: ws!.id, providerId: bob!.id, type: "immunizations", status: "complete" },
      { workspaceId: ws!.id, providerId: bob!.id, type: "background_check", status: "clear" },
      { workspaceId: ws!.id, providerId: bob!.id, type: "drug_screen", status: "clear" },
    ]);

  // Charlie — everything ready but wrong sub-specialty.
  const [charlie] = await db()
    .insert(schema.signalProviders)
    .values({
      workspaceId: ws!.id,
      name: "Charlie Crosswalk",
      specialties: ["pain"],
      regionPrefs: [],
    })
    .returning();
  await db()
    .insert(schema.signalCredentials)
    .values([
      {
        workspaceId: ws!.id,
        providerId: charlie!.id,
        type: "state_license",
        state: "MA",
        status: "active",
      },
      { workspaceId: ws!.id, providerId: charlie!.id, type: "dea", status: "active" },
      {
        workspaceId: ws!.id,
        providerId: charlie!.id,
        type: "state_csr",
        state: "MA",
        status: "active",
      },
      { workspaceId: ws!.id, providerId: charlie!.id, type: "board_cert", status: "certified" },
      { workspaceId: ws!.id, providerId: charlie!.id, type: "acls", status: "active" },
      { workspaceId: ws!.id, providerId: charlie!.id, type: "immunizations", status: "complete" },
      { workspaceId: ws!.id, providerId: charlie!.id, type: "background_check", status: "clear" },
      { workspaceId: ws!.id, providerId: charlie!.id, type: "drug_screen", status: "clear" },
    ]);

  // Record a lineage pointer for Alice so the explain lineage test
  // has a real row to resolve back through.
  await recordLineage(db(), {
    workspaceId: ws!.id,
    canonicalTable: "signal_providers",
    canonicalId: alice!.id,
    externalSystem: "pilot_seed",
    externalId: `alice-${overrides.slug}`,
  });

  // Job: need_date far enough out that Alice & Charlie pass but tight
  // enough that Bob's new-license lane (~90 days) fails.
  const needDate = new Date();
  needDate.setUTCDate(needDate.getUTCDate() + 30);
  const [job] = await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId: ws!.id,
      specialty: "cardiac",
      state: "MA",
      region: "NE",
      pay: "1800.00",
      needDate: needDate.toISOString().slice(0, 10),
    })
    .returning();

  return {
    userId: user!.id,
    workspaceId: ws!.id,
    sid,
    aliceId: alice!.id,
    bobId: bob!.id,
    charlieId: charlie!.id,
    jobId: job!.id,
  };
}

async function call(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      ...(cookie ? { cookie: `cred_sid=${cookie}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  };
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("Signal · WS A core engine", () => {
  beforeAll(async () => {
    await clearAll();
  });
  beforeEach(async () => {
    await clearAll();
    // Force a fresh env read per test — some cases flip
    // SIGNAL_SERVICES_ENABLED on and off.
    resetEnvForTesting();
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  describe("kill-switch & feature flag gates", () => {
    it("SIGNAL_SERVICES_ENABLED=false → every /v1/signal/* route is 404", async () => {
      process.env.SIGNAL_SERVICES_ENABLED = "false";
      resetEnvForTesting();
      const seed = await seedWorkspace({ slug: "ks-off", signalEnabled: true });
      const app = buildApp();
      const res = await call(app, "GET", `/v1/signal/jobs/${seed.jobId}/ranking`, seed.sid);
      expect(res.status).toBe(404);
      process.env.SIGNAL_SERVICES_ENABLED = "true";
      resetEnvForTesting();
    });

    it("workspace signal_enabled=false → 503 with problem+json", async () => {
      process.env.SIGNAL_SERVICES_ENABLED = "true";
      resetEnvForTesting();
      const seed = await seedWorkspace({ slug: "tenant-off", signalEnabled: false });
      const app = buildApp();
      const res = await call(app, "GET", `/v1/signal/jobs/${seed.jobId}/ranking`, seed.sid);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("disabled_for_workspace");
    });

    it("no session → 401", async () => {
      process.env.SIGNAL_SERVICES_ENABLED = "true";
      resetEnvForTesting();
      const seed = await seedWorkspace({ slug: "no-sess", signalEnabled: true });
      const app = buildApp();
      const res = await call(app, "GET", `/v1/signal/jobs/${seed.jobId}/ranking`, undefined);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/signal/jobs/:id/ranking", () => {
    it("happy path → Alice ranks above Charlie (match beats mismatch) and Bob is dropped (hard filter)", async () => {
      const seed = await seedWorkspace({ slug: "rank-happy", signalEnabled: true });
      const app = buildApp();
      const res = await call(app, "GET", `/v1/signal/jobs/${seed.jobId}/ranking`, seed.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        candidates: Array<{ providerId: string; score: number; reasons: unknown[] }>;
        rankingId: string;
        cached: boolean;
      };
      expect(body.cached).toBe(false);
      const ids = body.candidates.map((c) => c.providerId);
      expect(ids).toContain(seed.aliceId);
      // Bob needs ~90d for a new MA license; job's need_date is 30d
      // out → hard filter drops him.
      expect(ids).not.toContain(seed.bobId);
      // Alice (match + region) must outrank Charlie (mismatch) when both pass.
      const aliceIdx = ids.indexOf(seed.aliceId);
      const charlieIdx = ids.indexOf(seed.charlieId);
      if (charlieIdx !== -1) {
        expect(aliceIdx).toBeLessThan(charlieIdx);
      }
      // Ranking was snapshotted.
      const rows = await db()
        .select()
        .from(schema.signalRankings)
        .where(eq(schema.signalRankings.workspaceId, seed.workspaceId));
      expect(rows.length).toBe(1);
    });

    it("rankJobCandidates is deterministic for the same inputs (direct library call)", async () => {
      const seed = await seedWorkspace({ slug: "deterministic", signalEnabled: true });
      const today = new Date("2026-01-01T00:00:00Z");
      const r1 = await rankJobCandidates({
        workspaceId: seed.workspaceId,
        jobId: seed.jobId,
        today,
      });
      const r2 = await rankJobCandidates({
        workspaceId: seed.workspaceId,
        jobId: seed.jobId,
        today,
      });
      expect(r1.candidates.map((c) => [c.providerId, c.score])).toEqual(
        r2.candidates.map((c) => [c.providerId, c.score]),
      );
    });
  });

  describe("GET /v1/signal/providers/:id/fit", () => {
    it("returns openings for a known provider", async () => {
      const seed = await seedWorkspace({ slug: "fit", signalEnabled: true });
      const app = buildApp();
      const res = await call(app, "GET", `/v1/signal/providers/${seed.aliceId}/fit`, seed.sid);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { openings: Array<{ jobId: string }> };
      expect(body.openings.map((o) => o.jobId)).toContain(seed.jobId);
    });

    it("unknown provider → 404", async () => {
      const seed = await seedWorkspace({ slug: "fit-404", signalEnabled: true });
      const app = buildApp();
      const res = await call(
        app,
        "GET",
        "/v1/signal/providers/00000000-0000-0000-0000-000000000000/fit",
        seed.sid,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/signal/overrides", () => {
    it("is idempotent per (workspace, job, provider, user) — two POSTs = one row, direction updated", async () => {
      const seed = await seedWorkspace({ slug: "ovr-idem", signalEnabled: true });
      const app = buildApp();
      const first = await call(app, "POST", "/v1/signal/overrides", seed.sid, {
        jobId: seed.jobId,
        providerId: seed.aliceId,
        direction: "pin",
        reason: "great fit",
      });
      expect(first.status).toBe(201);
      const second = await call(app, "POST", "/v1/signal/overrides", seed.sid, {
        jobId: seed.jobId,
        providerId: seed.aliceId,
        direction: "demote",
        reason: "changed my mind",
      });
      expect(second.status).toBe(200);
      const rows = await db()
        .select()
        .from(schema.signalOverrides)
        .where(eq(schema.signalOverrides.workspaceId, seed.workspaceId));
      expect(rows.length).toBe(1);
      expect(rows[0]!.direction).toBe("demote");
      expect(rows[0]!.reasonText).toBe("changed my mind");
    });

    it("missing reason → 400", async () => {
      const seed = await seedWorkspace({ slug: "ovr-400", signalEnabled: true });
      const app = buildApp();
      const res = await call(app, "POST", "/v1/signal/overrides", seed.sid, {
        jobId: seed.jobId,
        providerId: seed.aliceId,
        direction: "pin",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/signal/reasons/:reason_id/source — lineage resolver", () => {
    it("resolves the recorded lineage row for a (table, id) pair", async () => {
      const seed = await seedWorkspace({ slug: "lineage", signalEnabled: true });
      const app = buildApp();
      const res = await call(
        app,
        "GET",
        `/v1/signal/reasons/signal_providers:${seed.aliceId}/source`,
        seed.sid,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        canonicalTable: string;
        canonicalId: string;
        sources: Array<{ externalSystem: string; externalId: string }>;
      };
      expect(body.canonicalTable).toBe("signal_providers");
      expect(body.canonicalId).toBe(seed.aliceId);
      expect(body.sources.some((s) => s.externalSystem === "pilot_seed")).toBe(true);
    });

    it("unknown pair → 404", async () => {
      const seed = await seedWorkspace({ slug: "lineage-404", signalEnabled: true });
      const app = buildApp();
      const res = await call(
        app,
        "GET",
        "/v1/signal/reasons/signal_providers:00000000-0000-0000-0000-000000000000/source",
        seed.sid,
      );
      expect(res.status).toBe(404);
    });

    it("every ranking reason's sourceLineageRef maps to a real signal_source_lineage row (after recording)", async () => {
      const seed = await seedWorkspace({ slug: "lineage-rank", signalEnabled: true });
      const result = await rankJobCandidates({
        workspaceId: seed.workspaceId,
        jobId: seed.jobId,
      });
      // Record one lineage row per unique (table, id) seen in the reasons.
      const seen = new Set<string>();
      for (const c of result.candidates) {
        for (const r of c.reasons) {
          const key = `${r.sourceLineageRef.canonicalTable}:${r.sourceLineageRef.canonicalId}`;
          if (!seen.has(key)) {
            await recordLineage(db(), {
              workspaceId: seed.workspaceId,
              canonicalTable: r.sourceLineageRef.canonicalTable,
              canonicalId: r.sourceLineageRef.canonicalId,
              externalSystem: "test_fixture",
              externalId: key,
            });
            seen.add(key);
          }
        }
      }
      // Now every ref must resolve to >= 1 row.
      for (const c of result.candidates) {
        for (const r of c.reasons) {
          const rows = await db()
            .select()
            .from(schema.signalSourceLineage)
            .where(eq(schema.signalSourceLineage.canonicalId, r.sourceLineageRef.canonicalId));
          expect(rows.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("POST /v1/signal/conversations/consent & eval runs & ingest webhook", () => {
    it("consent update flips conversation row", async () => {
      const seed = await seedWorkspace({ slug: "consent", signalEnabled: true });
      const [convo] = await db()
        .insert(schema.signalConversations)
        .values({
          workspaceId: seed.workspaceId,
          channel: "email",
          consentState: "pending",
          body: "Available May; prefers Texas.",
        })
        .returning();
      const app = buildApp();
      const res = await call(app, "POST", "/v1/signal/conversations/consent", seed.sid, {
        conversationId: convo!.id,
        state: "granted",
      });
      expect(res.status).toBe(200);
      const [updated] = await db()
        .select({
          consentState: schema.signalConversations.consentState,
          body: schema.signalConversations.body,
        })
        .from(schema.signalConversations)
        .where(eq(schema.signalConversations.id, convo!.id));
      expect(updated?.consentState).toBe("granted");
      // Grant keeps the body around for the ranker/UI to read.
      expect(updated?.body).toBe("Available May; prefers Texas.");
    });

    it("revoke nulls the body but keeps the row for audit", async () => {
      const seed = await seedWorkspace({ slug: "consent-revoke", signalEnabled: true });
      const [convo] = await db()
        .insert(schema.signalConversations)
        .values({
          workspaceId: seed.workspaceId,
          channel: "email",
          consentState: "granted",
          body: "Sensitive provider content here.",
        })
        .returning();
      const app = buildApp();
      const res = await call(app, "POST", "/v1/signal/conversations/consent", seed.sid, {
        conversationId: convo!.id,
        state: "revoked",
      });
      expect(res.status).toBe(200);
      const [updated] = await db()
        .select()
        .from(schema.signalConversations)
        .where(eq(schema.signalConversations.id, convo!.id));
      expect(updated?.consentState).toBe("revoked");
      expect(updated?.body).toBeNull();
      // Row stays — occurred_at, channel preserved.
      expect(updated?.channel).toBe("email");
    });

    it("implied_outbound rows cannot be flipped through the consent API", async () => {
      const seed = await seedWorkspace({ slug: "consent-frozen", signalEnabled: true });
      const [convo] = await db()
        .insert(schema.signalConversations)
        .values({
          workspaceId: seed.workspaceId,
          channel: "email",
          consentState: "implied_outbound",
          body: "Outbound recruiter email we authored.",
        })
        .returning();
      const app = buildApp();
      const res = await call(app, "POST", "/v1/signal/conversations/consent", seed.sid, {
        conversationId: convo!.id,
        state: "revoked",
      });
      expect(res.status).toBe(409);
    });

    it("eval run returns 202 and records a queued conversation row", async () => {
      const seed = await seedWorkspace({ slug: "eval", signalEnabled: true });
      const app = buildApp();
      const res = await call(app, "POST", "/v1/signal/eval/runs", seed.sid, {
        suite: "smoke",
        notes: "manual trigger",
      });
      expect(res.status).toBe(202);
      const rows = await db()
        .select({ channel: schema.signalConversations.channel })
        .from(schema.signalConversations)
        .where(eq(schema.signalConversations.workspaceId, seed.workspaceId));
      expect(rows[0]?.channel).toBe("eval");
    });

    it("ingest webhook rejects when adapter secret is unset", async () => {
      const seed = await seedWorkspace({ slug: "ingest-nosecret", signalEnabled: true });
      // Make sure the secret is unset.
      const prior = process.env.SIGNAL_INGEST_ACME_SECRET;
      delete process.env.SIGNAL_INGEST_ACME_SECRET;
      const app = buildApp();
      const res = await call(
        app,
        "POST",
        "/v1/signal/ingest/acme/webhook",
        seed.sid,
        { event: "ping" },
        { "x-signal-signature": "deadbeef" },
      );
      expect(res.status).toBe(401);
      if (prior !== undefined) process.env.SIGNAL_INGEST_ACME_SECRET = prior;
    });

    it("ingest webhook accepts a valid HMAC signature", async () => {
      const seed = await seedWorkspace({ slug: "ingest-ok", signalEnabled: true });
      process.env.SIGNAL_INGEST_ACME_SECRET = "s3cret";
      const { createHmac } = await import("node:crypto");
      const payload = JSON.stringify({ id: "msg-1", hello: "world" });
      const sig = createHmac("sha256", "s3cret").update(payload, "utf8").digest("hex");
      const app = buildApp();
      const res = await call(app, "POST", "/v1/signal/ingest/acme/webhook", seed.sid, payload, {
        "x-signal-signature": `sha256=${sig}`,
      });
      expect(res.status).toBe(202);
      // Lineage recorded against conversation id.
      const rows = await db()
        .select()
        .from(schema.signalSourceLineage)
        .where(eq(schema.signalSourceLineage.workspaceId, seed.workspaceId));
      expect(rows.some((r) => r.externalId === "msg-1")).toBe(true);
      delete process.env.SIGNAL_INGEST_ACME_SECRET;
    });
  });

  describe("learn worker · applyOverridesToWeights", () => {
    it("promotes raise weights for facets present on the promoted candidate", async () => {
      const seed = await seedWorkspace({ slug: "learn-up", signalEnabled: true });
      // Materialize a ranking so the learn worker can find the facets.
      await rankJobCandidates({ workspaceId: seed.workspaceId, jobId: seed.jobId });
      // Promote Alice.
      await db().insert(schema.signalOverrides).values({
        workspaceId: seed.workspaceId,
        jobId: seed.jobId,
        providerId: seed.aliceId,
        userId: seed.userId,
        direction: "pin",
        reasonText: "best option",
      });
      const result = await applyOverridesToWeights({ workspaceId: seed.workspaceId });
      expect(result.overridesConsidered).toBe(1);
      // At least one facet moved — Alice's entry has
      // SUBSPECIALTY_MATCH and AVAILABLE_BY_NEED_DATE at minimum.
      expect(result.changes.length).toBeGreaterThan(0);
      for (const c of result.changes) {
        expect(c.after).toBeGreaterThan(c.before);
      }
      const rows = await db()
        .select()
        .from(schema.signalWeights)
        .where(eq(schema.signalWeights.workspaceId, seed.workspaceId));
      expect(rows.length).toBe(result.changes.length);
    });

    it("tenant isolation: another workspace's weights are untouched", async () => {
      const a = await seedWorkspace({ slug: "learn-a", signalEnabled: true });
      const b = await seedWorkspace({ slug: "learn-b", signalEnabled: true });
      await rankJobCandidates({ workspaceId: a.workspaceId, jobId: a.jobId });
      await rankJobCandidates({ workspaceId: b.workspaceId, jobId: b.jobId });
      await db().insert(schema.signalOverrides).values({
        workspaceId: a.workspaceId,
        jobId: a.jobId,
        providerId: a.aliceId,
        userId: a.userId,
        direction: "pin",
        reasonText: "A-side promote",
      });
      await applyOverridesToWeights({ workspaceId: a.workspaceId });
      const aRows = await db()
        .select()
        .from(schema.signalWeights)
        .where(eq(schema.signalWeights.workspaceId, a.workspaceId));
      const bRows = await db()
        .select()
        .from(schema.signalWeights)
        .where(eq(schema.signalWeights.workspaceId, b.workspaceId));
      expect(aRows.length).toBeGreaterThan(0);
      expect(bRows.length).toBe(0);
    });

    it("clamps weights to the documented [0.1, 3.0] band", async () => {
      const seed = await seedWorkspace({ slug: "learn-clamp", signalEnabled: true });
      await rankJobCandidates({ workspaceId: seed.workspaceId, jobId: seed.jobId });
      // Spam 30 promotes — compounding 1.1^30 well over 3.0, so the
      // clamp is the only thing between us and runaway weights.
      for (let i = 0; i < 30; i++) {
        await db()
          .insert(schema.signalOverrides)
          .values({
            workspaceId: seed.workspaceId,
            jobId: seed.jobId,
            providerId: seed.aliceId,
            userId: seed.userId,
            direction: "pin",
            reasonText: `promote ${i}`,
          });
      }
      await applyOverridesToWeights({ workspaceId: seed.workspaceId });
      const rows = await db()
        .select()
        .from(schema.signalWeights)
        .where(eq(schema.signalWeights.workspaceId, seed.workspaceId));
      for (const r of rows) {
        const w = Number(r.weight);
        expect(w).toBeLessThanOrEqual(3.0);
        expect(w).toBeGreaterThanOrEqual(0.1);
      }
    });
  });

  // Silence a lint if drizzleSql isn't referenced elsewhere — keeps
  // the import resilient to refactors that pull SQL predicates down.
  void drizzleSql;
});
