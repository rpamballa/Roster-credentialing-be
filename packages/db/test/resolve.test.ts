import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateSignalTables } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { db, closeDb } = await import("../src/client.js");
const { signalProviders } = await import("../src/schema/signal/providers.js");
const { workspaces } = await import("../src/schema/workspaces.js");
const { resolveProvider, mergeProviders, unmergeLastProvider } = await import(
  "../src/signal/resolve.js"
);
const { and, eq } = await import("drizzle-orm");

describe("resolveProvider — entity resolution v0", () => {
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

  it("creates on first call, then an exact NPI match reuses the row", async () => {
    const ws = await seedWorkspace();

    const first = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Alpha",
      npi: "1234567890",
    });
    expect(first.created).toBe(true);

    const second = await resolveProvider({
      workspaceId: ws,
      // Deliberately-different cosmetic details — NPI wins.
      name: "A. Alpha",
      npi: "1234567890",
    });
    expect(second.created).toBe(false);
    expect(second.providerId).toBe(first.providerId);

    const rows = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  it("reuses on email match (case-insensitive)", async () => {
    const ws = await seedWorkspace();

    const first = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Beta",
      email: "beta@example.com",
    });

    const second = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Beta",
      email: "BETA@EXAMPLE.COM",
    });
    expect(second.providerId).toBe(first.providerId);
    expect(second.created).toBe(false);
  });

  it("reuses on phone match (normalized to digits)", async () => {
    const ws = await seedWorkspace();

    const first = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Gamma",
      phone: "(617) 555-0199",
    });

    const second = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Gamma",
      phone: "+1-617-555-0199",
    });
    expect(second.providerId).toBe(first.providerId);
    expect(second.created).toBe(false);
  });

  it("near-name without any identifier stays separate (false-negative-preferring)", async () => {
    const ws = await seedWorkspace();

    const first = await resolveProvider({
      workspaceId: ws,
      name: "John Smith",
    });
    const second = await resolveProvider({
      workspaceId: ws,
      // Same name, no shared identifier — must NOT merge.
      name: "John Smith",
    });

    expect(second.providerId).not.toBe(first.providerId);
    expect(second.created).toBe(true);

    const rows = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(rows).toHaveLength(2);
  });

  it("does not cross workspace boundaries (same NPI in a different workspace = new row)", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();

    const inA = await resolveProvider({
      workspaceId: a,
      name: "Shared Across Agencies",
      npi: "1234567890",
    });
    const inB = await resolveProvider({
      workspaceId: b,
      name: "Shared Across Agencies",
      npi: "1234567890",
    });

    expect(inA.providerId).not.toBe(inB.providerId);
    expect(inA.created).toBe(true);
    expect(inB.created).toBe(true);
  });

  it("explicit merge is reversible — mergeProviders then unmergeLastProvider restores the old row", async () => {
    const ws = await seedWorkspace();

    const a = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Alpha (variant A)",
      npi: "1111111111",
    });
    const b = await resolveProvider({
      workspaceId: ws,
      name: "Dr. Alpha (variant B)",
      email: "alpha@example.com",
    });

    // Operator decides A and B are the same person — merge B INTO A.
    const merge = await mergeProviders({
      workspaceId: ws,
      survivingId: a.providerId,
      mergedId: b.providerId,
    });
    expect(merge.providerId).toBe(a.providerId);

    const afterMerge = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(afterMerge).toHaveLength(1);
    const survivor = afterMerge[0];
    if (!survivor) throw new Error("expected surviving row");
    expect(survivor.id).toBe(a.providerId);
    expect(survivor.mergedFrom).toHaveLength(1);

    // Undo.
    const undo = await unmergeLastProvider({
      workspaceId: ws,
      survivingId: a.providerId,
    });
    expect(undo.restoredId).toBe(b.providerId);

    const afterUnmerge = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(afterUnmerge).toHaveLength(2);

    const restored = await db()
      .select()
      .from(signalProviders)
      .where(and(eq(signalProviders.workspaceId, ws), eq(signalProviders.id, b.providerId)));
    expect(restored).toHaveLength(1);
    expect(restored[0]?.email).toBe("alpha@example.com");

    // Survivor's merged_from is cleared after the undo.
    const survivorAfter = await db()
      .select()
      .from(signalProviders)
      .where(and(eq(signalProviders.workspaceId, ws), eq(signalProviders.id, a.providerId)));
    expect(survivorAfter[0]?.mergedFrom).toEqual([]);
  });
});
