import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateSignalTables } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { db, closeDb } = await import("../src/client.js");
const { signalProviders } = await import("../src/schema/signal/providers.js");
const { signalSourceLineage } = await import("../src/schema/signal/sourceLineage.js");
const { workspaces } = await import("../src/schema/workspaces.js");
const { recordLineage, lineageForCanonical } = await import("../src/signal/lineage.js");
const { and, eq } = await import("drizzle-orm");

describe("recordLineage", () => {
  beforeAll(async () => {
    await truncateSignalTables(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateSignalTables(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  async function seedWorkspace(): Promise<string> {
    const [row] = await db()
      .insert(workspaces)
      .values({
        type: "agency",
        name: `WS ${randomUUID().slice(0, 8)}`,
        slug: `ws-${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) throw new Error("workspace insert failed");
    return row.id;
  }

  async function seedProvider(workspaceId: string): Promise<string> {
    const [row] = await db()
      .insert(signalProviders)
      .values({ workspaceId, name: "Dr. Lineage" })
      .returning({ id: signalProviders.id });
    if (!row) throw new Error("provider insert failed");
    return row.id;
  }

  it("inserts a new lineage row on first call", async () => {
    const ws = await seedWorkspace();
    const providerId = await seedProvider(ws);

    const out = await recordLineage(db(), {
      workspaceId: ws,
      canonicalTable: "signal_providers",
      canonicalId: providerId,
      externalSystem: "bullhorn",
      externalId: "bh-123",
    });

    expect(out.workspaceId).toBe(ws);
    expect(out.canonicalId).toBe(providerId);
    expect(out.externalSystem).toBe("bullhorn");
    expect(out.externalId).toBe("bh-123");

    const rows = await db()
      .select()
      .from(signalSourceLineage)
      .where(eq(signalSourceLineage.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  it("upserts on same (workspace, canonical, external) tuple and bumps last_synced", async () => {
    const ws = await seedWorkspace();
    const providerId = await seedProvider(ws);

    const first = await recordLineage(db(), {
      workspaceId: ws,
      canonicalTable: "signal_providers",
      canonicalId: providerId,
      externalSystem: "bullhorn",
      externalId: "bh-123",
    });

    // Explicit micro-sleep so last_synced strictly advances. The
    // upsert uses `now()` server-side so the clock here doesn't
    // need to drift — but we want to prove the UPDATE ran.
    await new Promise((r) => setTimeout(r, 20));

    const second = await recordLineage(db(), {
      workspaceId: ws,
      canonicalTable: "signal_providers",
      canonicalId: providerId,
      externalSystem: "bullhorn",
      externalId: "bh-123",
    });

    expect(second.id).toBe(first.id);
    expect(second.lastSynced.getTime()).toBeGreaterThanOrEqual(first.lastSynced.getTime());

    // Still exactly one row — no duplicate from the second call.
    const rows = await db()
      .select()
      .from(signalSourceLineage)
      .where(
        and(
          eq(signalSourceLineage.workspaceId, ws),
          eq(signalSourceLineage.canonicalTable, "signal_providers"),
          eq(signalSourceLineage.canonicalId, providerId),
          eq(signalSourceLineage.externalSystem, "bullhorn"),
          eq(signalSourceLineage.externalId, "bh-123"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("keeps lineage rows per external system — different system = new row", async () => {
    const ws = await seedWorkspace();
    const providerId = await seedProvider(ws);

    await recordLineage(db(), {
      workspaceId: ws,
      canonicalTable: "signal_providers",
      canonicalId: providerId,
      externalSystem: "bullhorn",
      externalId: "bh-123",
    });
    await recordLineage(db(), {
      workspaceId: ws,
      canonicalTable: "signal_providers",
      canonicalId: providerId,
      externalSystem: "resend",
      externalId: "msg_abc",
    });

    const rows = await lineageForCanonical(db(), {
      workspaceId: ws,
      canonicalTable: "signal_providers",
      canonicalId: providerId,
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.externalSystem))).toEqual(new Set(["bullhorn", "resend"]));
  });
});
