import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { closeDb, db } = await import("@cred/db");
const { signalConversations, signalExtracts, workspaces } = await import("@cred/db/schema");
const { and, eq } = await import("drizzle-orm");

const { runExtracts } = await import("../src/runner.js");
const { extractsForWorkspace } = await import("../src/query.js");

async function seedWorkspace(): Promise<string> {
  const slug = `ws-ext-${randomUUID().slice(0, 6)}`;
  const [row] = await db()
    .insert(workspaces)
    .values({ type: "agency", name: slug, slug, isPlatformDefault: false })
    .returning({ id: workspaces.id });
  if (!row) throw new Error("seedWorkspace failed");
  return row.id;
}

async function seedConversation(opts: {
  workspaceId: string;
  body: string;
  consentState?: string;
}): Promise<string> {
  const [row] = await db()
    .insert(signalConversations)
    .values({
      workspaceId: opts.workspaceId,
      channel: "email",
      consentState: opts.consentState ?? "implied_outbound",
      body: opts.body,
    })
    .returning({ id: signalConversations.id });
  if (!row) throw new Error("seedConversation failed");
  return row.id;
}

describe("runExtracts — DB-backed", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("extracts all five facets from a rich conversation body", async () => {
    const ws = await seedWorkspace();
    const convId = await seedConversation({
      workspaceId: ws,
      body: "Prefers Texas assignments, available from February, wants $200/hr for cardiac anesthesia.",
    });

    const summary = await runExtracts({ workspaceId: ws });
    expect(summary.conversationsProcessed).toBe(1);
    expect(summary.extractsInserted).toBeGreaterThan(0);

    const rows = await db()
      .select({ facet: signalExtracts.facet })
      .from(signalExtracts)
      .where(and(eq(signalExtracts.workspaceId, ws), eq(signalExtracts.conversationId, convId)));
    const facets = new Set(rows.map((r) => r.facet));
    expect(facets.has("REGION_PREFERENCE")).toBe(true);
    expect(facets.has("TIMING_WINDOW")).toBe(true);
    expect(facets.has("RATE_EXPECTATION")).toBe(true);
    expect(facets.has("SUBSPECIALTY_INTEREST")).toBe(true);
    expect(facets.has("AVAILABILITY_SIGNAL")).toBe(true);
  });

  it("revoked conversations produce no extracts", async () => {
    const ws = await seedWorkspace();
    await seedConversation({
      workspaceId: ws,
      body: "Prefers Texas, $200/hr, available in March.",
      consentState: "revoked",
    });
    const summary = await runExtracts({ workspaceId: ws });
    expect(summary.bodiesHidden).toBe(1);
    expect(summary.extractsInserted).toBe(0);
    const rows = await db().select().from(signalExtracts).where(eq(signalExtracts.workspaceId, ws));
    expect(rows).toHaveLength(0);
  });

  it("pending conversations are also skipped (conservative default)", async () => {
    const ws = await seedWorkspace();
    await seedConversation({
      workspaceId: ws,
      body: "Prefers Texas, $200/hr, available in March.",
      consentState: "pending",
    });
    const summary = await runExtracts({ workspaceId: ws });
    expect(summary.bodiesHidden).toBe(1);
    expect(summary.extractsInserted).toBe(0);
  });

  it("idempotent: a second run inserts zero new rows", async () => {
    const ws = await seedWorkspace();
    await seedConversation({
      workspaceId: ws,
      body: "Open to OB anesthesia; available May; rate $180/hr.",
    });
    const first = await runExtracts({ workspaceId: ws });
    expect(first.extractsInserted).toBeGreaterThan(0);

    const before = await db()
      .select({ id: signalExtracts.id })
      .from(signalExtracts)
      .where(eq(signalExtracts.workspaceId, ws));
    const second = await runExtracts({ workspaceId: ws });
    expect(second.extractsInserted).toBe(0);
    expect(second.extractsSkipped).toBeGreaterThan(0);
    const after = await db()
      .select({ id: signalExtracts.id })
      .from(signalExtracts)
      .where(eq(signalExtracts.workspaceId, ws));
    expect(after.length).toBe(before.length);
  });

  it("extractsForWorkspace hides extracts on a revoke-after-extract flow", async () => {
    const ws = await seedWorkspace();
    const convId = await seedConversation({
      workspaceId: ws,
      body: "Prefers Texas, $200/hr, available in March.",
    });
    await runExtracts({ workspaceId: ws });
    const visibleBefore = await extractsForWorkspace(ws);
    expect(visibleBefore.length).toBeGreaterThan(0);

    // Revoke — physical extract rows remain, but the query helper
    // joins back through conversation.consent_state and hides them.
    await db()
      .update(signalConversations)
      .set({ consentState: "revoked" })
      .where(eq(signalConversations.id, convId));
    const visibleAfter = await extractsForWorkspace(ws);
    expect(visibleAfter).toHaveLength(0);
  });

  it("conversations with null body are a no-op (not counted as hidden)", async () => {
    const ws = await seedWorkspace();
    const [row] = await db()
      .insert(signalConversations)
      .values({
        workspaceId: ws,
        channel: "email",
        consentState: "implied_outbound",
        body: null,
      })
      .returning({ id: signalConversations.id });
    expect(row).toBeTruthy();
    const summary = await runExtracts({ workspaceId: ws });
    expect(summary.conversationsProcessed).toBe(1);
    expect(summary.extractsInserted).toBe(0);
    expect(summary.bodiesHidden).toBe(0);
  });
});
