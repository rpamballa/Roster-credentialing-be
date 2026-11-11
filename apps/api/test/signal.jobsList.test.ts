// Tests for GET /v1/signal/jobs — the workspace-scoped list endpoint
// that powers both Signal landing pages. The per-ranking endpoint and
// the rest of the Signal surface are covered by signal.wsA.test.ts;
// this file sticks to the list contract so a failure here points at
// the list route itself, not the engine behind it.

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

interface SeedCtx {
  sid: string;
  workspaceId: string;
}

async function seedWorkspace(opts: { slug: string; signalEnabled: boolean }): Promise<SeedCtx> {
  const [ws] = await db()
    .insert(schema.workspaces)
    .values({
      name: `Agency ${opts.slug}`,
      slug: opts.slug,
      type: "agency",
      signalEnabled: opts.signalEnabled,
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
  return { sid, workspaceId: ws!.id };
}

// Seed a deterministic mix of jobs the list endpoint should include /
// exclude so the tests below assert on a known shape.
async function seedJobMix(workspaceId: string): Promise<{
  cardiacMAId: string;
  pediatricTXId: string;
  cardiacCAId: string;
}> {
  const futureNear = new Date();
  futureNear.setUTCDate(futureNear.getUTCDate() + 7);
  const futureFar = new Date();
  futureFar.setUTCDate(futureFar.getUTCDate() + 60);
  const past = new Date();
  past.setUTCDate(past.getUTCDate() - 7);

  // Fully-populated open req — must appear.
  const [cardiacMA] = await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId,
      specialty: "cardiac",
      state: "MA",
      region: "NE",
      pay: "1800.00",
      needDate: futureNear.toISOString().slice(0, 10),
    })
    .returning();

  // Another open req — different specialty / state.
  const [pediatricTX] = await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId,
      specialty: "pediatric",
      state: "TX",
      region: "SW",
      pay: "1500.00",
      needDate: futureFar.toISOString().slice(0, 10),
    })
    .returning();

  // Cardiac in a different state — for state filter.
  const [cardiacCA] = await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId,
      specialty: "cardiac",
      state: "CA",
      region: "W",
      pay: "1900.00",
      needDate: futureFar.toISOString().slice(0, 10),
    })
    .returning();

  // Half-populated row (no state) — the ranker treats this as unusable,
  // the list endpoint should skip it.
  await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId,
      specialty: "cardiac",
      state: null,
      needDate: futureNear.toISOString().slice(0, 10),
    });

  // Already-expired need date — should drop off the default view.
  await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId,
      specialty: "cardiac",
      state: "MA",
      needDate: past.toISOString().slice(0, 10),
    });

  // No need_date at all — not a landable open req either.
  await db()
    .insert(schema.signalJobs)
    .values({
      workspaceId,
      specialty: "cardiac",
      state: "MA",
      needDate: null,
    });

  return {
    cardiacMAId: cardiacMA!.id,
    pediatricTXId: pediatricTX!.id,
    cardiacCAId: cardiacCA!.id,
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
    headers: {
      ...(cookie ? { cookie: `cred_sid=${cookie}` } : {}),
    },
  };
  return app.fetch(new Request(`http://localhost${path}`, init));
}

interface ListResponse {
  jobs: Array<{
    id: string;
    facilityId: string | null;
    specialty: string;
    needDate: string;
    state: string;
    reqOpenedAt: string;
  }>;
  total: number;
  limit: number;
}

describe("Signal · GET /v1/signal/jobs", () => {
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

  it("happy path — returns open reqs for the workspace, skips half-populated / expired rows", async () => {
    process.env.SIGNAL_SERVICES_ENABLED = "true";
    resetEnvForTesting();
    const seed = await seedWorkspace({ slug: "list-happy", signalEnabled: true });
    const ids = await seedJobMix(seed.workspaceId);
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    // Three open reqs with state + need_date in the future.
    const returnedIds = body.jobs.map((j) => j.id).sort();
    expect(returnedIds).toEqual(
      [ids.cardiacMAId, ids.pediatricTXId, ids.cardiacCAId].sort(),
    );
    expect(body.total).toBe(3);
    expect(body.limit).toBe(50);
    // Sorted by need_date ASC — nearest need comes first.
    expect(body.jobs[0]!.id).toBe(ids.cardiacMAId);
    // Every row carries the contract fields.
    for (const row of body.jobs) {
      expect(row.specialty).toBeTruthy();
      expect(row.state).toBeTruthy();
      expect(row.needDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(() => new Date(row.reqOpenedAt).toISOString()).not.toThrow();
    }
  });

  it("filters by specialty", async () => {
    const seed = await seedWorkspace({ slug: "list-spec", signalEnabled: true });
    const ids = await seedJobMix(seed.workspaceId);
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs?specialty=cardiac", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    const returnedIds = body.jobs.map((j) => j.id).sort();
    expect(returnedIds).toEqual([ids.cardiacMAId, ids.cardiacCAId].sort());
    expect(body.total).toBe(2);
  });

  it("filters by state", async () => {
    const seed = await seedWorkspace({ slug: "list-state", signalEnabled: true });
    const ids = await seedJobMix(seed.workspaceId);
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs?state=MA", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.jobs.map((j) => j.id)).toEqual([ids.cardiacMAId]);
    expect(body.total).toBe(1);
  });

  it("enforces the max limit (200) and honors custom limits", async () => {
    const seed = await seedWorkspace({ slug: "list-limit", signalEnabled: true });
    await seedJobMix(seed.workspaceId);
    const app = buildApp();

    // Custom limit returns at most that many rows.
    const res = await call(app, "GET", "/v1/signal/jobs?limit=1", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.jobs.length).toBe(1);
    expect(body.limit).toBe(1);
    // `total` is the count against the filter, not the returned slice.
    expect(body.total).toBe(3);

    // Over-limit requests are rejected at the validator.
    const over = await call(app, "GET", "/v1/signal/jobs?limit=500", seed.sid);
    expect(over.status).toBe(400);

    // Non-numeric limits bounce too.
    const bad = await call(app, "GET", "/v1/signal/jobs?limit=abc", seed.sid);
    expect(bad.status).toBe(400);
  });

  it("kill-switch: SIGNAL_SERVICES_ENABLED=false → 404", async () => {
    const seed = await seedWorkspace({ slug: "list-ks", signalEnabled: true });
    await seedJobMix(seed.workspaceId);
    process.env.SIGNAL_SERVICES_ENABLED = "false";
    resetEnvForTesting();
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs", seed.sid);
    expect(res.status).toBe(404);
    process.env.SIGNAL_SERVICES_ENABLED = "true";
    resetEnvForTesting();
  });

  it("workspace signal_enabled=false → 503 with problem+json", async () => {
    process.env.SIGNAL_SERVICES_ENABLED = "true";
    resetEnvForTesting();
    const seed = await seedWorkspace({ slug: "list-tenancy-off", signalEnabled: false });
    await seedJobMix(seed.workspaceId);
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs", seed.sid);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { type: string };
    expect(body.type).toContain("disabled_for_workspace");
  });

  it("no session → 401", async () => {
    process.env.SIGNAL_SERVICES_ENABLED = "true";
    resetEnvForTesting();
    const seed = await seedWorkspace({ slug: "list-no-sess", signalEnabled: true });
    await seedJobMix(seed.workspaceId);
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs", undefined);
    expect(res.status).toBe(401);
  });

  it("tenant isolation — workspace A never sees workspace B's jobs", async () => {
    const a = await seedWorkspace({ slug: "iso-a", signalEnabled: true });
    const b = await seedWorkspace({ slug: "iso-b", signalEnabled: true });
    const aIds = await seedJobMix(a.workspaceId);
    await seedJobMix(b.workspaceId);
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/jobs", a.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    const returned = new Set(body.jobs.map((j) => j.id));
    expect(returned.has(aIds.cardiacMAId)).toBe(true);
    expect(body.total).toBe(3);
  });
});
