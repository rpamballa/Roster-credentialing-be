// Tests for the ingestion-framework HTTP surface at /v1/signal/adapters/*.
// Scope: list / sync / preview / health / reset routes. Scheduler-level
// behavior is covered by packages/signal-ingest/test/scheduler.test.ts;
// here we only assert the HTTP contract (status codes, shapes, 404 on
// unknown adapter).

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
const { signalAdapterSyncState } = await import(
  "@cred/db/schema/signal/adapterSyncState"
);

async function clearAll(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql.unsafe(`
      TRUNCATE
        signal_adapter_sync_state,
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

async function seedWorkspace(slug: string): Promise<SeedCtx> {
  const [ws] = await db()
    .insert(schema.workspaces)
    .values({
      name: `Agency ${slug}`,
      slug,
      type: "agency",
      signalEnabled: true,
    })
    .returning({ id: schema.workspaces.id });
  const [user] = await db()
    .insert(schema.users)
    .values({
      email: `staff@${slug}.example`,
      name: `Staff ${slug}`,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  await db()
    .insert(schema.memberships)
    .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
  const sid = await createSession({
    userId: user!.id,
    email: `staff@${slug}.example`,
    activeWorkspaceId: ws!.id,
  });
  return { sid, workspaceId: ws!.id };
}

async function call(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  cookie: string | undefined,
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

describe("Signal · /v1/signal/adapters HTTP surface", () => {
  beforeAll(async () => {
    await clearAll();
  });
  beforeEach(async () => {
    await clearAll();
    resetEnvForTesting();
    process.env.SIGNAL_SERVICES_ENABLED = "true";
  });
  afterAll(async () => {
    await closeDb();
    await closeSessionStore();
  });

  it("GET /v1/signal/adapters lists the full registry with workspace-scoped health", async () => {
    const seed = await seedWorkspace("adapters-list");
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/adapters", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adapters: Array<{
        name: string;
        ok: boolean;
        breakerState: string;
        detail: string;
      }>;
    };
    const names = body.adapters.map((a) => a.name).sort();
    expect(names).toEqual(
      [
        "avionte",
        "bullhorn",
        "gmail",
        "laboredge",
        "outlook",
        "ringcentral",
        "roster-internal",
        "salesforce-crm",
        "twilio",
      ].sort(),
    );
    const internal = body.adapters.find((a) => a.name === "roster-internal")!;
    expect(internal.ok).toBe(true);
    const bullhorn = body.adapters.find((a) => a.name === "bullhorn")!;
    expect(bullhorn.ok).toBe(false);
    expect(bullhorn.detail).toMatch(/not configured/i);
  });

  it("GET /v1/signal/adapters requires a session (401 without cookie)", async () => {
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/adapters", undefined);
    expect(res.status).toBe(401);
  });

  it("POST /v1/signal/adapters/:adapter/preview returns counts for roster-internal", async () => {
    const seed = await seedWorkspace("adapters-preview");
    const app = buildApp();
    const res = await call(app, "POST", "/v1/signal/adapters/roster-internal/preview", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      preview: {
        providerCount: number;
        jobCount: number;
        facilityCount: number;
        credentialCount: number;
        conversationCount: number;
      } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.preview).not.toBeNull();
    expect(typeof body.preview!.providerCount).toBe("number");
  });

  it("POST /v1/signal/adapters/:adapter/preview on a stub returns ok:false + notImplemented", async () => {
    const seed = await seedWorkspace("adapters-preview-stub");
    const app = buildApp();
    const res = await call(app, "POST", "/v1/signal/adapters/bullhorn/preview", seed.sid);
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      notImplemented?: { adapter: string; required: Record<string, unknown> };
    };
    expect(body.ok).toBe(false);
    expect(body.notImplemented?.adapter).toBe("bullhorn");
    expect(body.notImplemented?.required).toBeDefined();
  });

  it("GET /v1/signal/adapters/:adapter/health returns the per-adapter report", async () => {
    const seed = await seedWorkspace("adapters-health");
    const app = buildApp();
    const res = await call(app, "GET", "/v1/signal/adapters/roster-internal/health", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adapter: string;
      ok: boolean;
      breakerState: string;
      consecutiveFailures: number;
    };
    expect(body.adapter).toBe("roster-internal");
    expect(body.ok).toBe(true);
    expect(body.breakerState).toBe("closed");
  });

  it("unknown adapter → 404 on every verb", async () => {
    const seed = await seedWorkspace("adapters-unknown");
    const app = buildApp();
    for (const [method, path] of [
      ["POST", "/v1/signal/adapters/does-not-exist/sync"],
      ["POST", "/v1/signal/adapters/does-not-exist/preview"],
      ["GET", "/v1/signal/adapters/does-not-exist/health"],
      ["DELETE", "/v1/signal/adapters/does-not-exist/state"],
    ] as const) {
      const res = await call(app, method, path, seed.sid);
      expect(res.status).toBe(404);
    }
  });

  it("POST /v1/signal/adapters/roster-internal/sync writes a sync_state row", async () => {
    const seed = await seedWorkspace("adapters-sync-roster");
    const app = buildApp();
    const res = await call(app, "POST", "/v1/signal/adapters/roster-internal/sync", seed.sid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; adapter: string; breakerState: string };
    expect(body.ok).toBe(true);
    expect(body.adapter).toBe("roster-internal");

    const rows = await db().select().from(signalAdapterSyncState);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.adapter).toBe("roster-internal");
    expect(rows[0]?.breakerState).toBe("closed");
    expect(rows[0]?.workspaceId).toBe(seed.workspaceId);
  });

  it("DELETE /v1/signal/adapters/:adapter/state clears the row", async () => {
    const seed = await seedWorkspace("adapters-reset");
    const app = buildApp();
    await call(app, "POST", "/v1/signal/adapters/roster-internal/sync", seed.sid);
    const resetRes = await call(
      app,
      "DELETE",
      "/v1/signal/adapters/roster-internal/state",
      seed.sid,
    );
    expect(resetRes.status).toBe(200);
    const rows = await db().select().from(signalAdapterSyncState);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cursor).toBeNull();
    expect(rows[0]?.breakerState).toBe("closed");
    expect(rows[0]?.consecutiveFailures).toBe(0);
  });
});
