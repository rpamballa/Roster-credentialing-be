// Signal · specialist call-list endpoint.
//
// Exercises GET /v1/signal/specialist/call-list — the deck-spec
// "Providers ranked by fit, engagement and likelihood to respond"
// surface that collapses per-job rankings into one row per provider.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

async function clearAll(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      TRUNCATE
        signal_eval_runs,
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

interface Seed {
  workspaceId: string;
  sid: string;
  aliceId: string;
  bobId: string;
  charlieId: string;
  jobMaId: string;
}

async function seedCallList(opts: { slug: string }): Promise<Seed> {
  const [ws] = await db()
    .insert(schema.workspaces)
    .values({
      name: `Agency ${opts.slug}`,
      slug: opts.slug,
      type: "agency",
      signalEnabled: true,
    })
    .returning({ id: schema.workspaces.id });
  const [user] = await db()
    .insert(schema.users)
    .values({
      email: `staff@${opts.slug}.example`,
      name: `Staff ${opts.slug}`,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  await db()
    .insert(schema.memberships)
    .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
  const sid = await createSession({
    userId: user!.id,
    email: `staff@${opts.slug}.example`,
    activeWorkspaceId: ws!.id,
  });

  // Alice — all credentials active, matching cardiac/NE.
  const [alice] = await db()
    .insert(schema.signalProviders)
    .values({
      workspaceId: ws!.id,
      name: "Alice Anesthesia",
      specialties: ["cardiac", "transplant"],
      regionPrefs: ["MA"],
    })
    .returning();
  // Bob — missing MA license, will be dropped on hard filter.
  const [bob] = await db()
    .insert(schema.signalProviders)
    .values({
      workspaceId: ws!.id,
      name: "Bob Backfill",
      specialties: ["cardiac"],
      regionPrefs: ["RI"],
    })
    .returning();
  // Charlie — sub-specialty mismatch but passes.
  const [charlie] = await db()
    .insert(schema.signalProviders)
    .values({
      workspaceId: ws!.id,
      name: "Charlie Crosswalk",
      specialties: ["pain"],
      regionPrefs: ["NY"],
    })
    .returning();

  const base = { workspaceId: ws!.id };
  await db()
    .insert(schema.signalCredentials)
    .values([
      { ...base, providerId: alice!.id, type: "state_license", state: "MA", status: "active" },
      { ...base, providerId: alice!.id, type: "state_license", state: "NY", status: "active" },
      { ...base, providerId: alice!.id, type: "dea", status: "active" },
      { ...base, providerId: alice!.id, type: "state_csr", state: "MA", status: "active" },
      { ...base, providerId: alice!.id, type: "board_cert", status: "certified" },
      { ...base, providerId: alice!.id, type: "acls", status: "active" },
      { ...base, providerId: alice!.id, type: "immunizations", status: "complete" },
      { ...base, providerId: alice!.id, type: "background_check", status: "clear" },
      { ...base, providerId: alice!.id, type: "drug_screen", status: "clear" },
      // Bob — NO MA license.
      { ...base, providerId: bob!.id, type: "dea", status: "active" },
      { ...base, providerId: bob!.id, type: "state_csr", state: "MA", status: "active" },
      { ...base, providerId: bob!.id, type: "board_cert", status: "certified" },
      { ...base, providerId: bob!.id, type: "acls", status: "active" },
      { ...base, providerId: bob!.id, type: "immunizations", status: "complete" },
      { ...base, providerId: bob!.id, type: "background_check", status: "clear" },
      { ...base, providerId: bob!.id, type: "drug_screen", status: "clear" },
      { ...base, providerId: charlie!.id, type: "state_license", state: "MA", status: "active" },
      { ...base, providerId: charlie!.id, type: "state_license", state: "NY", status: "active" },
      { ...base, providerId: charlie!.id, type: "dea", status: "active" },
      { ...base, providerId: charlie!.id, type: "state_csr", state: "MA", status: "active" },
      { ...base, providerId: charlie!.id, type: "board_cert", status: "certified" },
      { ...base, providerId: charlie!.id, type: "acls", status: "active" },
      { ...base, providerId: charlie!.id, type: "immunizations", status: "complete" },
      { ...base, providerId: charlie!.id, type: "background_check", status: "clear" },
      { ...base, providerId: charlie!.id, type: "drug_screen", status: "clear" },
    ]);

  const needDate = new Date();
  needDate.setUTCDate(needDate.getUTCDate() + 30);
  const [jobMa] = await db()
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

  // Alice: warming engagement — three conversations in the last 3 days.
  const now = new Date();
  await db()
    .insert(schema.signalConversations)
    .values([
      {
        workspaceId: ws!.id,
        providerId: alice!.id,
        channel: "sms",
        occurredAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
        consentState: "granted",
        summary: "Alice confirmed interest",
      },
      {
        workspaceId: ws!.id,
        providerId: alice!.id,
        channel: "sms",
        occurredAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
        consentState: "granted",
        summary: "Alice asked about rate",
      },
      {
        workspaceId: ws!.id,
        providerId: alice!.id,
        channel: "sms",
        occurredAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
        consentState: "granted",
        summary: "intro text",
      },
      // Charlie: dormant — only a 50-day-old conversation.
      {
        workspaceId: ws!.id,
        providerId: charlie!.id,
        channel: "email",
        occurredAt: new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000),
        consentState: "granted",
        summary: "intro email, no reply",
      },
    ]);

  return {
    workspaceId: ws!.id,
    sid,
    aliceId: alice!.id,
    bobId: bob!.id,
    charlieId: charlie!.id,
    jobMaId: jobMa!.id,
  };
}

async function call(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  cookie: string | undefined,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: cookie ? { cookie: `cred_sid=${cookie}` } : {},
  };
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("Signal · specialist call-list", () => {
  beforeAll(async () => {
    await clearAll();
  });
  beforeEach(async () => {
    await clearAll();
    resetEnvForTesting();
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  it("returns ranked providers deduped across open jobs, best score wins", async () => {
    const seed = await seedCallList({ slug: "callist-happy" });
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/specialist/call-list", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        id: string;
        name: string;
        matchScore: number;
        licenseStates: string[];
        engagement: string;
        topJobId: string;
      }>;
      total: number;
      limit: number;
      jobsScanned: number;
    };
    expect(body.jobsScanned).toBeGreaterThan(0);
    const ids = body.providers.map((p) => p.id);
    // Alice and Charlie pass; Bob is dropped by the per-job hard filter.
    expect(ids).toContain(seed.aliceId);
    expect(ids).not.toContain(seed.bobId);
    // Alice (full match + two licenses) outranks Charlie (sub-specialty miss).
    const aliceIdx = ids.indexOf(seed.aliceId);
    const charlieIdx = ids.indexOf(seed.charlieId);
    if (charlieIdx !== -1) expect(aliceIdx).toBeLessThan(charlieIdx);
    // Scores ordered descending.
    const scores = body.providers.map((p) => p.matchScore);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
    // License states enriched for Alice.
    const alice = body.providers.find((p) => p.id === seed.aliceId)!;
    expect(alice.licenseStates).toEqual(expect.arrayContaining(["MA", "NY"]));
    // Match score is a 0-100 INTEGER percent — the FE formatter just
    // appends `%`, so we assert the shape here. First-dogfood had the
    // chip rendering 2400%; the normalization lives in this route.
    for (const p of body.providers) {
      expect(Number.isInteger(p.matchScore)).toBe(true);
      expect(p.matchScore).toBeGreaterThanOrEqual(0);
      expect(p.matchScore).toBeLessThanOrEqual(100);
    }
  });

  it("classifies engagement from conversation recency + volume", async () => {
    const seed = await seedCallList({ slug: "callist-eng" });
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/specialist/call-list", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; engagement: string }>;
    };
    const alice = body.providers.find((p) => p.id === seed.aliceId);
    expect(alice).toBeTruthy();
    // ≥2 conversations in the last 7d → warming.
    expect(alice!.engagement).toBe("warming");
    const charlie = body.providers.find((p) => p.id === seed.charlieId);
    if (charlie) {
      // Last conversation 50 days ago → dormant.
      expect(charlie.engagement).toBe("dormant");
    }
  });

  it("respects the limit param", async () => {
    const seed = await seedCallList({ slug: "callist-limit" });
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/specialist/call-list?limit=1", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: unknown[];
      limit: number;
      total: number;
    };
    expect(body.limit).toBe(1);
    expect(body.providers.length).toBeLessThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(body.providers.length);
  });

  it("filters by engagement", async () => {
    const seed = await seedCallList({ slug: "callist-eng-filter" });
    const app = buildApp();
    const res = await call(
      app,
      "GET",
      "/v1/signal/specialist/call-list?engagement=warming",
      seed.sid,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; engagement: string }>;
    };
    for (const p of body.providers) {
      expect(p.engagement).toBe("warming");
    }
    const alice = body.providers.find((p) => p.id === seed.aliceId);
    expect(alice).toBeTruthy();
  });

  it("filters by specialty — mismatched specialty returns empty jobs scan", async () => {
    const seed = await seedCallList({ slug: "callist-specialty" });
    const app = buildApp();
    const res = await call(
      app,
      "GET",
      "/v1/signal/specialist/call-list?specialty=dermatology",
      seed.sid,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: unknown[];
      jobsScanned: number;
    };
    // No open cardiac or pain jobs under the specialty=dermatology
    // filter → zero open jobs scanned → zero providers.
    expect(body.jobsScanned).toBe(0);
    expect(body.providers.length).toBe(0);
  });

  it("401 when the request carries no session", async () => {
    await seedCallList({ slug: "callist-401" });
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/specialist/call-list", undefined);
    expect(res.status).toBe(401);
  });

  it("empty workspace (no open jobs) → empty list + jobsScanned=0", async () => {
    // Fresh workspace, no seed rows.
    const [ws] = await db()
      .insert(schema.workspaces)
      .values({ name: "Empty", slug: "callist-empty", type: "agency", signalEnabled: true })
      .returning({ id: schema.workspaces.id });
    const [user] = await db()
      .insert(schema.users)
      .values({
        email: "staff@empty.example",
        name: "Staff Empty",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    await db()
      .insert(schema.memberships)
      .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
    const sid = await createSession({
      userId: user!.id,
      email: "staff@empty.example",
      activeWorkspaceId: ws!.id,
    });
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/specialist/call-list", sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: unknown[];
      jobsScanned: number;
      total: number;
    };
    expect(body.jobsScanned).toBe(0);
    expect(body.providers).toEqual([]);
    expect(body.total).toBe(0);
  });
});
