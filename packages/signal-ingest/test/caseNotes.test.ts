import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { closeDb, db } = await import("@cred/db");
const { signalConversations, signalExtracts } = await import("@cred/db/schema");
const { eq } = await import("drizzle-orm");

const { seedCase, seedCaseNote, seedProvider, seedWorkspace } = await import("./helpers.js");
const { runIngestOnce } = await import("../src/runner.js");

/**
 * Case notes land in `signal_conversations` as channel="case_note"
 * with consent=`implied_outbound`, and the extract pipeline then
 * lifts facets out of them in the same cycle.
 */
describe("case-notes reader + extracts fan-out", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("imports case_notes as case_note conversations with implied_outbound consent", async () => {
    const ws = await seedWorkspace();
    const prov = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Case",
      npi: "7111111110",
      email: "case@example.com",
    });
    const caseId = await seedCase({ workspaceId: ws, providerId: prov });
    await seedCaseNote({
      workspaceId: ws,
      caseId,
      body: "Prefers Texas assignments, available from March. Wants $200/hr for cardiac anesthesia.",
    });

    const summary = await runIngestOnce({ workspaceId: ws });
    const convs = await db()
      .select()
      .from(signalConversations)
      .where(eq(signalConversations.workspaceId, ws));
    expect(convs.some((c) => c.channel === "case_note")).toBe(true);
    const note = convs.find((c) => c.channel === "case_note");
    expect(note?.consentState).toBe("implied_outbound");
    expect(note?.body).toContain("Texas");

    // Extracts ran as part of the same cycle and wrote facets.
    expect(summary.extractsRun).not.toBeNull();
    expect(summary.extractsRun?.extractsInserted).toBeGreaterThan(0);
    const extractRows = await db()
      .select({ facet: signalExtracts.facet })
      .from(signalExtracts)
      .where(eq(signalExtracts.workspaceId, ws));
    const facets = new Set(extractRows.map((r) => r.facet));
    expect(facets.has("REGION_PREFERENCE")).toBe(true);
    expect(facets.has("RATE_EXPECTATION")).toBe(true);
    expect(facets.has("SUBSPECIALTY_INTEREST")).toBe(true);
  });

  it("soft-deleted case_notes are skipped", async () => {
    const ws = await seedWorkspace();
    const prov = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Deleted",
      npi: "7222222220",
    });
    const caseId = await seedCase({ workspaceId: ws, providerId: prov });
    await seedCaseNote({
      workspaceId: ws,
      caseId,
      body: "This note was redacted.",
      deletedAt: new Date(),
    });
    await runIngestOnce({ workspaceId: ws });
    const convs = await db()
      .select()
      .from(signalConversations)
      .where(eq(signalConversations.workspaceId, ws));
    expect(convs.filter((c) => c.channel === "case_note")).toHaveLength(0);
  });

  it("re-running the full ingest is idempotent on case_note conversations AND their extracts", async () => {
    const ws = await seedWorkspace();
    const prov = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Repeat",
      npi: "7333333330",
    });
    const caseId = await seedCase({ workspaceId: ws, providerId: prov });
    await seedCaseNote({
      workspaceId: ws,
      caseId,
      body: "Open to OB anesthesia; available May; rate $180/hr.",
    });

    await runIngestOnce({ workspaceId: ws });
    const after1 = await db()
      .select({ id: signalExtracts.id })
      .from(signalExtracts)
      .where(eq(signalExtracts.workspaceId, ws));

    const second = await runIngestOnce({ workspaceId: ws });
    const after2 = await db()
      .select({ id: signalExtracts.id })
      .from(signalExtracts)
      .where(eq(signalExtracts.workspaceId, ws));
    expect(after2.length).toBe(after1.length);
    expect(second.extractsRun?.extractsInserted).toBe(0);
  });
});
