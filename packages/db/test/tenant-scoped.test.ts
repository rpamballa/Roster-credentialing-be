import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateSignalTables } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { db, closeDb } = await import("../src/client.js");
const { workspaces } = await import("../src/schema/workspaces.js");
const { withWorkspace } = await import("../src/signal/tenant-scoped.js");

describe("withWorkspace — Signal tenant-scoped DAL", () => {
  beforeAll(async () => {
    await truncateSignalTables(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateSignalTables(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  async function seedWorkspace(slug: string): Promise<string> {
    const [row] = await db()
      .insert(workspaces)
      .values({ type: "agency", name: slug, slug: `${slug}-${randomUUID().slice(0, 6)}` })
      .returning({ id: workspaces.id });
    if (!row) throw new Error("workspace insert failed");
    return row.id;
  }

  it("list(): a scoped query for workspace A never returns workspace B's rows", async () => {
    const a = await seedWorkspace("a");
    const b = await seedWorkspace("b");

    const scopedA = withWorkspace(a);
    const scopedB = withWorkspace(b);

    await scopedA.providers.insert({ name: "Dr. A1" });
    await scopedA.providers.insert({ name: "Dr. A2" });
    await scopedB.providers.insert({ name: "Dr. B1" });

    const aRows = await scopedA.providers.list();
    const bRows = await scopedB.providers.list();

    expect(aRows.map((r) => r.name).sort()).toEqual(["Dr. A1", "Dr. A2"]);
    expect(bRows.map((r) => r.name)).toEqual(["Dr. B1"]);
    expect(aRows.every((r) => r.workspaceId === a)).toBe(true);
    expect(bRows.every((r) => r.workspaceId === b)).toBe(true);
  });

  it("findById(): workspace A cannot pull workspace B's row by id", async () => {
    const a = await seedWorkspace("a");
    const b = await seedWorkspace("b");

    const scopedA = withWorkspace(a);
    const scopedB = withWorkspace(b);
    const [bRow] = await scopedB.providers.insert({ name: "Dr. B" });
    if (!bRow) throw new Error("expected insert to return row");

    const asA = await scopedA.providers.findById(bRow.id);
    const asB = await scopedB.providers.findById(bRow.id);
    expect(asA).toBeUndefined();
    expect(asB?.id).toBe(bRow.id);
  });

  it("insert() auto-stamps workspace_id and refuses a mismatched one", async () => {
    const a = await seedWorkspace("a");
    const b = await seedWorkspace("b");

    const scopedA = withWorkspace(a);
    // Omit workspaceId → helper stamps it with scope.workspaceId.
    const [row] = await scopedA.providers.insert({ name: "Dr. A" });
    expect(row?.workspaceId).toBe(a);

    // Pass a MISMATCHED workspaceId → fail-fast.
    await expect(
      scopedA.providers.insert({
        workspaceId: b,
        name: "Should Not Land In A",
      } as never),
    ).rejects.toThrow(/refusing insert/);

    // The refused row did not persist.
    const rowsInA = await scopedA.providers.list();
    expect(rowsInA.map((r) => r.name)).toEqual(["Dr. A"]);
  });

  it("validates workspaceId at the DAL boundary", () => {
    expect(() => withWorkspace("not-a-uuid")).toThrow(/valid UUID/);
  });
});
