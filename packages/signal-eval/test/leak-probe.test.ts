import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { closeDb, db } = await import("@cred/db");
const { workspaces } = await import("@cred/db/schema");
const { loadFixture } = await import("../src/index.js");
const { runLeakProbe } = await import("../src/leak-probe.js");

const FIXTURE_PATH = new URL("../fixtures/known-reqs-v0.json", import.meta.url).pathname;

async function seedWorkspace(slug: string): Promise<string> {
  const [row] = await db()
    .insert(workspaces)
    .values({ type: "agency", name: slug, slug: `${slug}-${randomUUID().slice(0, 6)}` })
    .returning({ id: workspaces.id });
  if (!row) throw new Error("workspace insert failed");
  return row.id;
}

describe("runLeakProbe", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("reports no leak — tenant A's rankings are byte-identical before and after tenant B is seeded", async () => {
    const tenantA = await seedWorkspace("tenantA");
    const tenantB = await seedWorkspace("tenantB");
    const fixture = loadFixture(FIXTURE_PATH);
    const result = await runLeakProbe({
      tenantAWorkspaceId: tenantA,
      tenantBWorkspaceId: tenantB,
      fixture,
      k: 3,
    });
    expect(result.leakDetected).toBe(false);
    expect(result.diffs).toEqual([]);
    // every req is identical
    for (const a of result.tenantAAfter.perReq) {
      const b = result.tenantABefore.perReq.find((r) => r.reqId === a.reqId);
      expect(b).toBeDefined();
      expect(a.rankerTop).toEqual(b?.rankerTop ?? []);
      expect(a.precisionAtK).toBe(b?.precisionAtK);
    }
  });
});
