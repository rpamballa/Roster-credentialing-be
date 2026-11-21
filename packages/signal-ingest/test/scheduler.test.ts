// Scheduler + adapter-framework tests.
//
// Scope: contract-level behavior of @cred/signal-ingest's scheduler
// and registry. Row-level DAL behavior of signal_* is already covered
// by runner.test.ts; here we assert the FRAMEWORK pieces:
//
//   1. Registry resolves known names + throws for unknown.
//   2. Scheduler advances the cursor on success and persists it; the
//      next run picks it back up.
//   3. Three consecutive failures trip `breaker_state` to 'open';
//      a run against an open row short-circuits without invoking the
//      adapter.
//   4. Dry-run (preview) returns counts without writing to signal_*.
//   5. External stubs raise `NotImplementedForOnboarding` with
//      structured `required` context.
//   6. Per-workspace isolation — one workspace's sync state does not
//      leak into another's.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { db, closeDb } = await import("@cred/db");
const { signalConversations, signalJobs, signalProviders } = await import("@cred/db/schema");
const { signalAdapterSyncState } = await import(
  "@cred/db/schema/signal/adapterSyncState"
);
const { and, eq } = await import("drizzle-orm");

const { seedWorkspace } = await import("./helpers.js");
const {
  BreakerOpenInDbError,
  DB_BREAKER_TRIP_AT,
  NotImplementedForOnboarding,
  UnknownAdapterError,
  adapterHealth,
  createRegistry,
  defaultAdapterRegistry,
  getAdapter,
  preview,
  resetAdapterState,
  rosterInternalAdapter,
  runOnce,
} = await import("../src/index.js");
const { bullhornAdapter } = await import("../src/adapters/external/bullhorn/index.js");
const { gmailAdapter } = await import("../src/adapters/external/gmail/index.js");

// A fake adapter we can steer deterministically — cursor advances by
// 1 per sync, errors can be scripted, preview returns a known shape.
function makeFakeAdapter(
  opts: {
    name?: string;
    failTimes?: number;
    cadenceMs?: number | null;
  } = {},
) {
  const name = opts.name ?? "fake-counter";
  let remainingFails = opts.failTimes ?? 0;
  let syncCalls = 0;
  let previewCalls = 0;
  const adapter = {
    name,
    supports: ["providers"] as const,
    cadenceMs: opts.cadenceMs ?? 60_000,
    async preview() {
      previewCalls += 1;
      return {
        providerCount: 42,
        jobCount: 0,
        facilityCount: 0,
        credentialCount: 0,
        conversationCount: 0,
        estimatedBackfillMinutes: 1,
      };
    },
    async sync(_ctx: unknown, cursor: unknown) {
      syncCalls += 1;
      if (remainingFails > 0) {
        remainingFails -= 1;
        throw new Error(`fake-counter: scripted failure #${syncCalls}`);
      }
      const prev =
        typeof cursor === "object" && cursor !== null && "n" in (cursor as Record<string, unknown>)
          ? Number((cursor as { n: unknown }).n) || 0
          : 0;
      return {
        cursor: { n: prev + 1 },
        counts: { providers: 1 },
      };
    },
    async backfill(_ctx: unknown, _since: Date) {
      return { cursor: { n: 0 }, counts: { providers: 0 } };
    },
    async health() {
      return { ok: true, detail: `${name}: ready` };
    },
  };
  return {
    adapter,
    stats: () => ({ syncCalls, previewCalls, remainingFails }),
  };
}

describe("adapter registry", () => {
  it("resolves every default adapter by name", () => {
    expect(getAdapter("roster-internal").name).toBe("roster-internal");
    expect(getAdapter("bullhorn").name).toBe("bullhorn");
    expect(getAdapter("gmail").name).toBe("gmail");
  });

  it("throws UnknownAdapterError for an unregistered name", () => {
    expect(() => getAdapter("not-a-real-adapter")).toThrow(UnknownAdapterError);
  });

  it("createRegistry refuses duplicate names", () => {
    const a = { ...rosterInternalAdapter };
    expect(() => createRegistry([a, a])).toThrow(/duplicate adapter name/);
  });

  it("defaultAdapterRegistry enumerates every vendor plus roster-internal", () => {
    const names = defaultAdapterRegistry.names().sort();
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
  });
});

describe("external stubs raise NotImplementedForOnboarding with structured context", () => {
  it("bullhorn.sync carries credentials, scopes, docs", async () => {
    let caught: unknown;
    try {
      await bullhornAdapter.sync(
        {
          workspaceId: "00000000-0000-0000-0000-000000000000",
          credentials: async () => null,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
        null,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotImplementedForOnboarding);
    const asNie = caught as InstanceType<typeof NotImplementedForOnboarding>;
    expect(asNie.adapter).toBe("bullhorn");
    expect(asNie.required.credentials).toEqual(
      expect.arrayContaining(["clientId", "clientSecret", "refreshToken", "restUrl"]),
    );
    expect(asNie.required.scopes).toEqual(["READ"]);
    expect(asNie.required.docs).toMatch(/bullhorn/i);
  });

  it("gmail.health reports 'not configured' without throwing", async () => {
    const h = await gmailAdapter.health({
      workspaceId: "00000000-0000-0000-0000-000000000000",
      credentials: async () => null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(h.ok).toBe(false);
    expect(h.lastError).toBe("not configured");
  });
});

describe("scheduler.runOnce — cursor advancement + persistence", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("first run advances cursor and writes signal_adapter_sync_state", async () => {
    const workspaceId = await seedWorkspace();
    const { adapter, stats } = makeFakeAdapter();
    const registry = createRegistry([adapter]);

    const first = await runOnce({ workspaceId, adapter: adapter.name, registry });
    expect(first.ok).toBe(true);
    expect(first.cursor).toEqual({ n: 1 });
    expect(stats().syncCalls).toBe(1);

    const [row] = await db()
      .select()
      .from(signalAdapterSyncState)
      .where(
        and(
          eq(signalAdapterSyncState.workspaceId, workspaceId),
          eq(signalAdapterSyncState.adapter, adapter.name),
        ),
      );
    expect(row?.cursor).toEqual({ n: 1 });
    expect(row?.breakerState).toBe("closed");
    expect(row?.consecutiveFailures).toBe(0);
  });

  it("second run starts from the persisted cursor", async () => {
    const workspaceId = await seedWorkspace();
    const { adapter } = makeFakeAdapter();
    const registry = createRegistry([adapter]);

    await runOnce({ workspaceId, adapter: adapter.name, registry });
    const second = await runOnce({ workspaceId, adapter: adapter.name, registry });
    expect(second.cursor).toEqual({ n: 2 });

    const third = await runOnce({ workspaceId, adapter: adapter.name, registry });
    expect(third.cursor).toEqual({ n: 3 });
  });
});

describe("scheduler.runOnce — three-strike DB breaker", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("flips breaker_state to 'open' after DB_BREAKER_TRIP_AT failures", async () => {
    const workspaceId = await seedWorkspace();
    const { adapter, stats } = makeFakeAdapter({ failTimes: DB_BREAKER_TRIP_AT + 1 });
    const registry = createRegistry([adapter]);

    const results = [] as Array<Awaited<ReturnType<typeof runOnce>>>;
    for (let i = 0; i < DB_BREAKER_TRIP_AT; i += 1) {
      results.push(await runOnce({ workspaceId, adapter: adapter.name, registry }));
    }
    for (const r of results) expect(r.ok).toBe(false);
    expect(results.at(-1)!.breakerState).toBe("open");

    // Subsequent run short-circuits — adapter.sync NOT invoked again.
    const beforeShortCircuit = stats().syncCalls;
    const shortCircuited = await runOnce({ workspaceId, adapter: adapter.name, registry });
    expect(shortCircuited.ok).toBe(false);
    expect(shortCircuited.error).toContain(
      new BreakerOpenInDbError(adapter.name, workspaceId).message,
    );
    expect(stats().syncCalls).toBe(beforeShortCircuit);
  });

  it("resetAdapterState re-closes the breaker and clears the cursor", async () => {
    const workspaceId = await seedWorkspace();
    const { adapter } = makeFakeAdapter({ failTimes: DB_BREAKER_TRIP_AT });
    const registry = createRegistry([adapter]);

    for (let i = 0; i < DB_BREAKER_TRIP_AT; i += 1) {
      await runOnce({ workspaceId, adapter: adapter.name, registry });
    }
    const beforeReset = await adapterHealth({ workspaceId, adapter: adapter.name, registry });
    expect(beforeReset.breakerState).toBe("open");

    await resetAdapterState({ workspaceId, adapter: adapter.name, registry });
    const afterReset = await adapterHealth({ workspaceId, adapter: adapter.name, registry });
    expect(afterReset.breakerState).toBe("closed");
    expect(afterReset.cursor).toBeNull();
  });
});

describe("scheduler.preview — dry-run does not write signal_* tables", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("preview returns counts but writes zero signal_* rows and zero sync-state rows", async () => {
    const workspaceId = await seedWorkspace();
    const { adapter } = makeFakeAdapter();
    const registry = createRegistry([adapter]);

    const before = {
      providers: (await db().select().from(signalProviders)).length,
      jobs: (await db().select().from(signalJobs)).length,
      conversations: (await db().select().from(signalConversations)).length,
      state: (await db().select().from(signalAdapterSyncState)).length,
    };
    const result = await preview({ workspaceId, adapter: adapter.name, registry });
    const after = {
      providers: (await db().select().from(signalProviders)).length,
      jobs: (await db().select().from(signalJobs)).length,
      conversations: (await db().select().from(signalConversations)).length,
      state: (await db().select().from(signalAdapterSyncState)).length,
    };
    expect(result.ok).toBe(true);
    expect(result.preview?.providerCount).toBe(42);
    expect(after).toEqual(before);
  });

  it("preview surfaces NotImplementedForOnboarding without tripping the breaker", async () => {
    const workspaceId = await seedWorkspace();
    const result = await preview({ workspaceId, adapter: "bullhorn" });
    expect(result.ok).toBe(false);
    expect(result.notImplemented?.adapter).toBe("bullhorn");
    expect(result.notImplemented?.required).toBeDefined();

    const rows = await db()
      .select()
      .from(signalAdapterSyncState)
      .where(
        and(
          eq(signalAdapterSyncState.workspaceId, workspaceId),
          eq(signalAdapterSyncState.adapter, "bullhorn"),
        ),
      );
    // Preview MUST NOT touch the sync-state table.
    expect(rows).toHaveLength(0);
  });
});

describe("scheduler per-workspace isolation", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("running roster-internal in workspace A does not touch workspace B's sync_state row", async () => {
    const wsA = await seedWorkspace({ slug: "iso-a" });
    const wsB = await seedWorkspace({ slug: "iso-b" });
    const { adapter } = makeFakeAdapter({ name: "iso-counter" });
    const registry = createRegistry([adapter]);

    await runOnce({ workspaceId: wsA, adapter: adapter.name, registry });
    await runOnce({ workspaceId: wsA, adapter: adapter.name, registry });

    const rowsA = await db()
      .select()
      .from(signalAdapterSyncState)
      .where(eq(signalAdapterSyncState.workspaceId, wsA));
    const rowsB = await db()
      .select()
      .from(signalAdapterSyncState)
      .where(eq(signalAdapterSyncState.workspaceId, wsB));
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.cursor).toEqual({ n: 2 });
    // workspace B never saw the adapter run — no row should exist.
    expect(rowsB).toHaveLength(0);
  });
});
