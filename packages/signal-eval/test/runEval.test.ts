import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { closeDb, db } = await import("@cred/db");
const { workspaces } = await import("@cred/db/schema");
const { loadFixture, runEval } = await import("../src/index.js");

const FIXTURE_PATH = new URL("../fixtures/known-reqs-v0.json", import.meta.url).pathname;

async function seedWorkspace(slug: string): Promise<string> {
  const [row] = await db()
    .insert(workspaces)
    .values({ type: "agency", name: slug, slug: `${slug}-${randomUUID().slice(0, 6)}` })
    .returning({ id: workspaces.id });
  if (!row) throw new Error("workspace insert failed");
  return row.id;
}

describe("runEval (DB-backed)", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("runs the v0 fixture end-to-end and reports per-req + aggregate", async () => {
    const workspaceId = await seedWorkspace("eval");
    const fixture = loadFixture(FIXTURE_PATH);
    const result = await runEval({ workspaceId, fixture, k: 3 });

    // one result row per req
    expect(result.perReq.length).toBe(fixture.reqs.length);
    for (const row of result.perReq) {
      // precision is a ratio in [0, 1]
      expect(row.precisionAtK).toBeGreaterThanOrEqual(0);
      expect(row.precisionAtK).toBeLessThanOrEqual(1);
      // top-K length is bounded by K
      expect(row.rankerTop.length).toBeLessThanOrEqual(3);
    }

    // aggregate is bounded in [0, 1]
    expect(result.aggregate.meanPrecisionAtK).toBeGreaterThanOrEqual(0);
    expect(result.aggregate.meanPrecisionAtK).toBeLessThanOrEqual(1);
    // every req is classified pass or fail
    expect(result.aggregate.passedCount + result.aggregate.failedCount).toBe(fixture.reqs.length);

    // The v0 fixture seeds providers so that every req's picks ARE
    // the only providers with the matching sub-specialty + region
    // across the fixture. The seeded hard-filter leaves all picks
    // available by needDate, and the soft score ranks picks above
    // non-picks (which lack the matching sub-specialty for THIS
    // req). So the ranker should land at mean precision >= 0.70.
    expect(result.aggregate.meanPrecisionAtK).toBeGreaterThanOrEqual(0.7);
  });

  it("is deterministic — two runs on the same seed produce identical top-K + precision", async () => {
    const workspaceId = await seedWorkspace("eval");
    const fixture = loadFixture(FIXTURE_PATH);
    // First run seeds and ranks.
    const r1 = await runEval({ workspaceId, fixture, k: 3 });
    // Second run reuses the same seeded data (no re-seed since
    // runEval is given a `seed`). We call runEval with the SAME
    // seed mapping by passing the seed from a fresh seedFixture.
    // Instead here we just re-rank against the same workspace
    // without re-seeding — rankJobCandidates is deterministic on
    // the same inputs + a fixed `today`.
    const { seedFixture } = await import("../src/seed.js");
    const wsB = await seedWorkspace("eval-b");
    const seedB = await seedFixture({ workspaceId: wsB, fixture });
    const r2 = await runEval({ workspaceId: wsB, fixture, k: 3, seed: seedB });
    // Both runs use the same fixture + same deterministic clock +
    // isolated workspaces with the same seeded shape. Each req's
    // top-K (as fixture picks) and precision should match exactly.
    for (const [i, a] of r1.perReq.entries()) {
      const b = r2.perReq[i];
      if (!b) throw new Error("misaligned perReq rows");
      expect(b.reqId).toBe(a.reqId);
      expect(b.rankerTop).toEqual(a.rankerTop);
      expect(b.precisionAtK).toBe(a.precisionAtK);
    }
  });

  it("refuses placeholder fixture when --require-consultant-labels is set", async () => {
    const workspaceId = await seedWorkspace("eval");
    const fixture = loadFixture(FIXTURE_PATH);
    await expect(
      runEval({
        workspaceId,
        fixture,
        requireConsultantLabels: true,
      }),
    ).rejects.toThrow(/placeholder-engineering-judgment/);
  });

  it("accepts a fixture labeled with consultant-grade labels", async () => {
    const workspaceId = await seedWorkspace("eval");
    const fixture = loadFixture(FIXTURE_PATH);
    const asConsultant = { ...fixture, label_source: "consultant-labels-v1" };
    await expect(
      runEval({
        workspaceId,
        fixture: asConsultant,
        requireConsultantLabels: true,
      }),
    ).resolves.toBeTruthy();
  });

  it("per-req report includes reasons the ranker emitted for each picked candidate", async () => {
    const workspaceId = await seedWorkspace("eval");
    const fixture = loadFixture(FIXTURE_PATH);
    const result = await runEval({ workspaceId, fixture, k: 3 });
    const first = result.perReq[0];
    if (!first) throw new Error("expected at least one perReq row");
    // every top-K candidate has a reason list attached
    for (const pick of first.rankerTop) {
      expect(first.reasonsMatched[pick]).toBeDefined();
      expect((first.reasonsMatched[pick] ?? []).length).toBeGreaterThan(0);
    }
  });
});
