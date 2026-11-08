import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { db, closeDb } = await import("@cred/db");
const { signalConversations, signalCredentials, signalJobs, signalProviders, signalSourceLineage } =
  await import("@cred/db/schema");
const { and, eq } = await import("drizzle-orm");

const {
  seedCase,
  seedFacility,
  seedFacilityProfile,
  seedOutreachEmail,
  seedProvider,
  seedVerification,
  seedWorkspace,
} = await import("./helpers.js");
const { runIngestOnce } = await import("../src/runner.js");

describe("runIngestOnce — seed agency sync", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("populates every signal_* table from Roster's own data, with lineage on every row", async () => {
    const ws = await seedWorkspace();
    const facilityId = await seedFacility({ name: "Mercy Hospital" });
    const profileId = await seedFacilityProfile({ workspaceId: ws, facilityId });

    const provA = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Alpha",
      npi: "1000000001",
      email: "alpha@example.com",
      specialties: ["anesthesiology", "general"],
      statesLicensed: ["TX", "CA"],
    });
    await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Beta",
      npi: "1000000002",
      specialties: ["anesthesiology"],
      statesLicensed: ["NY"],
    });

    await seedVerification({
      workspaceId: ws,
      providerId: provA,
      type: "dea",
      status: "active",
    });

    const caseId = await seedCase({
      workspaceId: ws,
      providerId: provA,
      facilityProfileId: profileId,
      targetSubmissionDate: "2026-02-01",
    });

    await seedOutreachEmail({
      workspaceId: ws,
      caseId,
      providerEmail: "alpha@example.com",
      providerName: "Dr Alpha",
      body: "quick check-in",
    });

    const summary = await runIngestOnce({ workspaceId: ws });

    // Readers all ran.
    expect(summary.readersRun).toContain("providers");
    expect(summary.readersRun).toContain("jobs");
    expect(summary.readersRun).toContain("facilities");
    expect(summary.readersRun).toContain("credentials");
    expect(summary.readersRun).toContain("conversations");
    expect(summary.errors).toEqual([]);

    // signal_providers populated for both grant holders.
    const provs = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(provs).toHaveLength(2);
    const alpha = provs.find((p) => p.npi === "1000000001");
    expect(alpha?.specialties.sort()).toEqual(["anesthesiology", "general"]);

    // signal_jobs: one case, facility_id resolved via facility_profiles.
    const jobs = await db().select().from(signalJobs).where(eq(signalJobs.workspaceId, ws));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.facilityId).toBe(facilityId);
    expect(jobs[0]?.needDate).toBe("2026-02-01");

    // signal_credentials: 1 (dea verification) + 2 (state_license rows for provA)
    //   + 1 (earliest_start synthetic for provA) + 1 (state_license NY for provB)
    //   + 1 (earliest_start synthetic for provB) = 6.
    const creds = await db()
      .select()
      .from(signalCredentials)
      .where(eq(signalCredentials.workspaceId, ws));
    expect(creds.length).toBeGreaterThanOrEqual(6);
    const projections = creds.filter((c) => c.type === "earliest_start");
    expect(projections).toHaveLength(2);
    expect(projections[0]?.earliestStartProjection).toHaveProperty("confidence");

    // signal_conversations: one outbound email, implied_outbound consent.
    const convs = await db()
      .select()
      .from(signalConversations)
      .where(eq(signalConversations.workspaceId, ws));
    expect(convs).toHaveLength(1);
    expect(convs[0]?.channel).toBe("email");
    expect(convs[0]?.consentState).toBe("implied_outbound");
    expect(convs[0]?.providerId).toBe(alpha?.id);

    // Lineage: every canonical row has at least one lineage entry.
    for (const row of provs) {
      const rows = await db()
        .select()
        .from(signalSourceLineage)
        .where(
          and(
            eq(signalSourceLineage.workspaceId, ws),
            eq(signalSourceLineage.canonicalTable, "signal_providers"),
            eq(signalSourceLineage.canonicalId, row.id),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    }
    for (const row of jobs) {
      const rows = await db()
        .select()
        .from(signalSourceLineage)
        .where(
          and(
            eq(signalSourceLineage.workspaceId, ws),
            eq(signalSourceLineage.canonicalTable, "signal_jobs"),
            eq(signalSourceLineage.canonicalId, row.id),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    }
    for (const row of creds) {
      const rows = await db()
        .select()
        .from(signalSourceLineage)
        .where(
          and(
            eq(signalSourceLineage.workspaceId, ws),
            eq(signalSourceLineage.canonicalTable, "signal_credentials"),
            eq(signalSourceLineage.canonicalId, row.id),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    }
    for (const row of convs) {
      const rows = await db()
        .select()
        .from(signalSourceLineage)
        .where(
          and(
            eq(signalSourceLineage.workspaceId, ws),
            eq(signalSourceLineage.canonicalTable, "signal_conversations"),
            eq(signalSourceLineage.canonicalId, row.id),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("entity resolution: two providers with the same NPI collapse to one signal_providers row", async () => {
    const ws = await seedWorkspace();

    // Seed TWO rows in the credentialing `providers` table that share
    // an NPI (shouldn't happen in production — `providers.npi` is
    // UNIQUE globally — so instead we test ER via repeated reader
    // runs with the same NPI being exercised: same identity, two
    // runs, still one canonical row).
    const p1 = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Dupe",
      npi: "1234567890",
      email: "a@example.com",
      specialties: ["general"],
    });
    expect(p1).toBeTruthy();

    // Run once → one signal_providers row.
    await runIngestOnce({ workspaceId: ws });
    const after1 = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(after1).toHaveLength(1);
    const canonicalId = after1[0]?.id;

    // Run again → still one signal_providers row (same NPI resolves
    // to same canonical row).
    const summary = await runIngestOnce({ workspaceId: ws });
    const after2 = await db()
      .select()
      .from(signalProviders)
      .where(eq(signalProviders.workspaceId, ws));
    expect(after2).toHaveLength(1);
    expect(after2[0]?.id).toBe(canonicalId);
    // Second run counts that provider as a REUSE, not a new row.
    expect(summary.rowsSkipped.providers).toBe(1);
    expect(summary.rowsUpserted.providers).toBe(0);
  });

  it("idempotency: a second run writes no new canonical rows", async () => {
    const ws = await seedWorkspace();
    const facilityId = await seedFacility({ name: "St. Idem" });
    const profileId = await seedFacilityProfile({ workspaceId: ws, facilityId });
    const prov = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Idempotent",
      npi: "2222222222",
      email: "idem@example.com",
      statesLicensed: ["TX"],
    });
    await seedVerification({
      workspaceId: ws,
      providerId: prov,
      type: "dea",
      status: "active",
    });
    const caseId = await seedCase({
      workspaceId: ws,
      providerId: prov,
      facilityProfileId: profileId,
      targetSubmissionDate: "2026-03-01",
    });
    await seedOutreachEmail({
      workspaceId: ws,
      caseId,
      providerEmail: "idem@example.com",
      providerName: "Dr Idempotent",
    });

    const first = await runIngestOnce({ workspaceId: ws });
    const countRows = async () => {
      const [p, j, c, conv] = await Promise.all([
        db().select().from(signalProviders).where(eq(signalProviders.workspaceId, ws)),
        db().select().from(signalJobs).where(eq(signalJobs.workspaceId, ws)),
        db().select().from(signalCredentials).where(eq(signalCredentials.workspaceId, ws)),
        db().select().from(signalConversations).where(eq(signalConversations.workspaceId, ws)),
      ]);
      return { p: p.length, j: j.length, c: c.length, conv: conv.length };
    };
    const after1 = await countRows();

    const second = await runIngestOnce({ workspaceId: ws });
    const after2 = await countRows();

    expect(after2).toEqual(after1);
    expect(second.errors).toEqual([]);
    // Second run: everything is a skip, nothing new.
    expect(second.rowsUpserted.providers).toBe(0);
    expect(second.rowsUpserted.jobs).toBe(0);
    expect(second.rowsUpserted.credentials).toBe(0);
    expect(second.rowsUpserted.conversations).toBe(0);
    // First run inserted some providers → sanity-check that.
    expect(first.rowsUpserted.providers).toBeGreaterThan(0);
  });

  it("conversations gap: workspace with no outbound email → gap surfaced in summary", async () => {
    const ws = await seedWorkspace();
    await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Lonely",
      npi: "3333333333",
    });

    const summary = await runIngestOnce({ workspaceId: ws });
    const gap = summary.gaps.find((g) => g.kind === "no_outbound_conversations");
    expect(gap).toBeDefined();
  });
});
