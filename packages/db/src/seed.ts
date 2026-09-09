/**
 * Idempotent local/demo seed data.
 *
 * Boots a single "acme" agency workspace with an owner and a specialist,
 * an approved facility profile for Regional Medical Center, three providers
 * with realistic document sets, and three cases in different states so the
 * platform has something to demo the moment the app boots.
 *
 * Safe to run repeatedly — every insert is guarded by a prior lookup or
 * an onConflict clause. The script runs from a controlled tool and bypasses
 * RLS explicitly; audit rows are written inline (mirroring the wrapper in
 * packages/observability/src/audit.ts) so this file has no upstream
 * dependency on @cred/observability.
 *
 * Usage:
 *   pnpm db:seed
 */
import type { ActorType, Blocker, ExtractedField, FacilityRequirements } from "@cred/types";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import * as schema from "./schema/index.js";

const WORKSPACE_SLUG = "acme";
const OWNER_EMAIL = "owner@acme.example.com";
const SPECIALIST_EMAIL = "sam@acme.example.com";
const FACILITY_NAME = "Regional Medical Center";
const FACILITY_ADDRESS = "123 Main St, Austin, TX";

const now = new Date();

function offsetDays(days: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const BBOX: [number, number, number, number] = [0.1, 0.1, 0.6, 0.05];

interface SeedOutputCase {
  providerName: string;
  caseId: string;
  status: string;
}

interface SeedOutput {
  workspaceId: string;
  ownerUserId: string;
  specialistUserId: string;
  facilityProfileId: string;
  cases: SeedOutputCase[];
}

interface AuditParams {
  workspaceId: string | null;
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  targetEntityType: string;
  targetEntityId: string;
  after?: unknown;
}

// Inline audit writer — mirrors packages/observability/src/audit.ts so the
// seed script does not need to depend on @cred/observability (which itself
// depends on @cred/db). Every non-null `after` payload we pass here is
// PHI-free identifier metadata, so no redaction is needed at this call site.
async function seedAudit(params: AuditParams): Promise<void> {
  // rls: bypass — audit writes are privileged; workspaceId is set explicitly.
  await db()
    .insert(schema.auditLog)
    .values({
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      action: params.action,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId,
      afterState: params.after ?? null,
    });
}

// -------------------------------------------------------------------------
// Facility requirements — hand-authored packet matching the FacilityRequirements
// contract in packages/types/src/facility-requirements.ts.
// -------------------------------------------------------------------------
const FACILITY_REQUIREMENTS: FacilityRequirements = {
  required_documents: [
    { type: "medical_license", count: 1, attestation_required: true },
    { type: "dea", count: 1, attestation_required: false },
    { type: "board_certification", count: 1, attestation_required: false },
    { type: "bls", count: 1, attestation_required: false },
  ],
  required_verifications: [
    {
      type: "state_license",
      source_priority: ["state_board"],
      recency_days: 90,
    },
  ],
  privilege_delineations: [
    {
      specialty: "Emergency Medicine",
      privileges: [
        { name: "General EM", requires_volume: false },
        {
          name: "Procedural sedation",
          requires_volume: true,
          threshold: { count: 20, period_months: 12 },
        },
      ],
    },
  ],
  attestations: [
    {
      text: "I attest that all information provided is accurate to the best of my knowledge.",
      signer_role: "provider",
      format: "signature",
    },
  ],
  submission: {
    method: "email",
    recipient: "credentialing@regionalmed.example.com",
    deadline_days_before_effective: 14,
  },
  facility_forms: [],
};

// -------------------------------------------------------------------------
// Extracted-field builders — mirror packages/ai/src/extractors/*.ts expected
// fields with realistic values and high confidence so the fields render as
// "extracted" in demos without needing to re-run extraction.
// -------------------------------------------------------------------------
function licenseFields(
  licenseNumber: string,
  state: string,
  licenseeName: string,
  expiration: Date,
  specialty: string,
): ExtractedField[] {
  return [
    { name: "license_number", value: licenseNumber, confidence: 0.98, page: 0, bbox: BBOX },
    { name: "state", value: state, confidence: 0.97, page: 0, bbox: BBOX },
    {
      name: "issue_date",
      value: isoDate(offsetDays(-1400)),
      confidence: 0.94,
      page: 0,
      bbox: BBOX,
    },
    { name: "expiration_date", value: isoDate(expiration), confidence: 0.97, page: 0, bbox: BBOX },
    { name: "license_status", value: "Active", confidence: 0.95, page: 0, bbox: BBOX },
    { name: "licensee_name", value: licenseeName, confidence: 0.96, page: 0, bbox: BBOX },
    { name: "specialty", value: specialty, confidence: 0.92, page: 0, bbox: BBOX },
  ];
}

function deaFields(deaNumber: string, name: string, expiration: Date): ExtractedField[] {
  return [
    { name: "dea_number", value: deaNumber, confidence: 0.98, page: 0, bbox: BBOX },
    { name: "registrant_name", value: name, confidence: 0.96, page: 0, bbox: BBOX },
    { name: "schedule", value: "2,2N,3,3N,4,5", confidence: 0.95, page: 0, bbox: BBOX },
    { name: "issue_date", value: isoDate(offsetDays(-700)), confidence: 0.94, page: 0, bbox: BBOX },
    { name: "expiration_date", value: isoDate(expiration), confidence: 0.97, page: 0, bbox: BBOX },
  ];
}

function boardCertFields(name: string, expiration: Date): ExtractedField[] {
  return [
    { name: "diplomate_name", value: name, confidence: 0.97, page: 0, bbox: BBOX },
    { name: "specialty", value: "Emergency Medicine", confidence: 0.98, page: 0, bbox: BBOX },
    { name: "certifying_board", value: "ABEM", confidence: 0.96, page: 0, bbox: BBOX },
    {
      name: "issue_date",
      value: isoDate(offsetDays(-1800)),
      confidence: 0.94,
      page: 0,
      bbox: BBOX,
    },
    { name: "expiration_date", value: isoDate(expiration), confidence: 0.97, page: 0, bbox: BBOX },
    {
      name: "moc_status",
      value: "Meeting MOC requirements",
      confidence: 0.92,
      page: 0,
      bbox: BBOX,
    },
  ];
}

function blsFields(name: string, expiration: Date): ExtractedField[] {
  return [
    { name: "holder_name", value: name, confidence: 0.97, page: 0, bbox: BBOX },
    { name: "issuing_organization", value: "AHA", confidence: 0.98, page: 0, bbox: BBOX },
    { name: "issue_date", value: isoDate(offsetDays(-540)), confidence: 0.94, page: 0, bbox: BBOX },
    { name: "expiration_date", value: isoDate(expiration), confidence: 0.97, page: 0, bbox: BBOX },
  ];
}

// -------------------------------------------------------------------------
// Idempotent helpers — every "seed X" function returns the id and whether
// it was created on this run so the audit trail only records genuine inserts.
// -------------------------------------------------------------------------
async function seedWorkspace(): Promise<{ id: string; created: boolean }> {
  // rls: bypass — seed script, controlled environment.
  const existing = await db()
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.slug, WORKSPACE_SLUG))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const [row] = await db()
    .insert(schema.workspaces)
    .values({
      type: "agency",
      name: "Acme Locums",
      slug: WORKSPACE_SLUG,
      emailInAddress: `requirements+${WORKSPACE_SLUG}@platform.example.com`,
    })
    .returning({ id: schema.workspaces.id });
  if (!row) throw new Error("workspace insert failed");
  return { id: row.id, created: true };
}

async function seedUser(email: string): Promise<{ id: string; created: boolean }> {
  // rls: bypass — seed script.
  const existing = await db()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const [row] = await db()
    .insert(schema.users)
    .values({ email, emailVerifiedAt: now })
    .returning({ id: schema.users.id });
  if (!row) throw new Error(`user insert failed: ${email}`);
  return { id: row.id, created: true };
}

async function seedMembership(
  userId: string,
  workspaceId: string,
  role: "owner" | "specialist",
): Promise<void> {
  // rls: bypass — seed script; onConflict guards the compound PK.
  await db().insert(schema.memberships).values({ userId, workspaceId, role }).onConflictDoNothing();
}

async function seedFacility(): Promise<{ id: string }> {
  // rls: bypass — seed script. Facilities have no unique constraint on name,
  // so we look up by (name, address) which is unique for our seed data.
  const existing = await db()
    .select({ id: schema.facilities.id })
    .from(schema.facilities)
    .where(
      and(
        eq(schema.facilities.name, FACILITY_NAME),
        eq(schema.facilities.address, FACILITY_ADDRESS),
      ),
    )
    .limit(1);
  if (existing[0]) return { id: existing[0].id };

  const [row] = await db()
    .insert(schema.facilities)
    .values({ name: FACILITY_NAME, address: FACILITY_ADDRESS })
    .returning({ id: schema.facilities.id });
  if (!row) throw new Error("facility insert failed");
  return { id: row.id };
}

async function seedFacilityProfile(
  facilityId: string,
  workspaceId: string,
  approverId: string,
): Promise<{ id: string; created: boolean }> {
  // rls: bypass — seed script.
  const existing = await db()
    .select({ id: schema.facilityProfiles.id })
    .from(schema.facilityProfiles)
    .where(
      and(
        eq(schema.facilityProfiles.facilityId, facilityId),
        eq(schema.facilityProfiles.workspaceId, workspaceId),
        eq(schema.facilityProfiles.version, 1),
      ),
    )
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const [row] = await db()
    .insert(schema.facilityProfiles)
    .values({
      facilityId,
      workspaceId,
      version: 1,
      status: "approved",
      requirements: FACILITY_REQUIREMENTS,
      approvedAt: now,
      approvedBy: approverId,
    })
    .returning({ id: schema.facilityProfiles.id });
  if (!row) throw new Error("facility profile insert failed");

  // Immutable history row — matches the approve-profile pattern in
  // apps/api/src/graphql/resolvers/facility.ts.
  await db().insert(schema.facilityProfileVersions).values({
    facilityProfileId: row.id,
    workspaceId,
    version: 1,
    requirements: FACILITY_REQUIREMENTS,
    approvedAt: now,
    approvedBy: approverId,
  });

  return { id: row.id, created: true };
}

interface ProviderSeed {
  npi: string;
  firstName: string;
  lastName: string;
  email: string;
  statesLicensed: string[];
}

async function seedProvider(p: ProviderSeed): Promise<{ id: string; created: boolean }> {
  // rls: bypass — providers are global (see providers.ts docstring); npi is unique.
  const existing = await db()
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(eq(schema.providers.npi, p.npi))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const [row] = await db()
    .insert(schema.providers)
    .values({
      npi: p.npi,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      specialties: ["Emergency Medicine"],
      statesLicensed: p.statesLicensed,
    })
    .returning({ id: schema.providers.id });
  if (!row) throw new Error(`provider insert failed: ${p.npi}`);
  return { id: row.id, created: true };
}

async function seedGrant(
  providerId: string,
  workspaceId: string,
  grantedBy: string,
): Promise<void> {
  // rls: bypass — seed script; onConflict guards the compound PK.
  await db()
    .insert(schema.providerWorkspaceGrants)
    .values({ providerId, workspaceId, grantedBy })
    .onConflictDoNothing();
}

async function seedDocument(params: {
  providerId: string;
  documentType: "medical_license" | "dea" | "board_certification" | "bls";
  expiresAt: Date;
  extractedFields: ExtractedField[];
}): Promise<void> {
  const fileUri = `seed/${params.providerId}/${params.documentType}.pdf`;
  // rls: bypass — seed script. Documents have no unique constraint; the
  // deterministic fileUri lets us detect a prior seed row.
  const existing = await db()
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.providerId, params.providerId),
        eq(schema.documents.documentType, params.documentType),
        eq(schema.documents.fileUri, fileUri),
      ),
    )
    .limit(1);
  if (existing[0]) return;

  await db().insert(schema.documents).values({
    providerId: params.providerId,
    documentType: params.documentType,
    fileUri,
    source: "provider_upload",
    extractionStatus: "succeeded",
    extractedFields: params.extractedFields,
    extractedAt: now,
    confirmedAt: now,
    expiresAt: params.expiresAt,
  });
}

interface CaseSeed {
  providerId: string;
  providerName: string;
  workspaceId: string;
  facilityProfileId: string;
  specialistId: string;
  status:
    | "intake"
    | "in_progress"
    | "awaiting_provider"
    | "awaiting_references"
    | "ready_for_review"
    | "submitted"
    | "completed"
    | "withdrawn";
  openedAt: Date;
  blockers?: Blocker[];
}

async function seedCase(
  seed: CaseSeed,
): Promise<{ id: string; created: boolean; status: string; providerName: string }> {
  // rls: bypass — seed script. Cases have no unique constraint; a single
  // seeded case per (workspace, provider) is sufficient for demo purposes.
  const existing = await db()
    .select({ id: schema.cases.id, status: schema.cases.status })
    .from(schema.cases)
    .where(
      and(
        eq(schema.cases.workspaceId, seed.workspaceId),
        eq(schema.cases.providerId, seed.providerId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return {
      id: existing[0].id,
      created: false,
      status: existing[0].status,
      providerName: seed.providerName,
    };
  }

  const [row] = await db()
    .insert(schema.cases)
    .values({
      workspaceId: seed.workspaceId,
      providerId: seed.providerId,
      facilityProfileId: seed.facilityProfileId,
      facilityProfileVersion: "1",
      specialty: "Emergency Medicine",
      purpose: "initial_appointment",
      status: seed.status,
      openedAt: seed.openedAt,
      assignedSpecialistId: seed.specialistId,
      blockers: seed.blockers ?? [],
    })
    .returning({ id: schema.cases.id });
  if (!row) throw new Error(`case insert failed for ${seed.providerName}`);
  return { id: row.id, created: true, status: seed.status, providerName: seed.providerName };
}

async function seedOutreachForMarcus(params: {
  workspaceId: string;
  caseId: string;
}): Promise<void> {
  // rls: bypass — seed script.
  const existing = await db()
    .select({ id: schema.outreachThreads.id })
    .from(schema.outreachThreads)
    .where(
      and(
        eq(schema.outreachThreads.caseId, params.caseId),
        eq(schema.outreachThreads.recipientKind, "provider"),
      ),
    )
    .limit(1);
  let threadId = existing[0]?.id;
  if (!threadId) {
    const [row] = await db()
      .insert(schema.outreachThreads)
      .values({
        workspaceId: params.workspaceId,
        caseId: params.caseId,
        recipientKind: "provider",
        recipientName: "Marcus Reed",
        recipientEmail: "marcus.reed@example.com",
        recipientPhone: "+15125550142",
        status: "active",
      })
      .returning({ id: schema.outreachThreads.id });
    if (!row) throw new Error("outreach thread insert failed");
    threadId = row.id;
  }

  // Guard duplicate messages by (thread, template) since template names are
  // deterministic in this seed.
  const messagesExisting = await db()
    .select({ template: schema.outreachMessages.template })
    .from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.threadId, threadId));
  const havingTemplate = new Set(messagesExisting.map((m) => m.template));

  if (!havingTemplate.has("provider_invite_d0_email")) {
    await db()
      .insert(schema.outreachMessages)
      .values({
        threadId,
        workspaceId: params.workspaceId,
        channel: "email",
        direction: "out",
        template: "provider_invite_d0_email",
        body:
          "Hi Marcus — Acme Locums is starting your credentialing packet for Regional Medical " +
          "Center. Please upload your board certification, BLS card, and any updated license via " +
          "the link in this email.",
        scheduledAt: offsetDays(-7),
        sentAt: offsetDays(-7),
      });
  }
  if (!havingTemplate.has("provider_reminder_d3_sms")) {
    await db()
      .insert(schema.outreachMessages)
      .values({
        threadId,
        workspaceId: params.workspaceId,
        channel: "sms",
        direction: "out",
        template: "provider_reminder_d3_sms",
        body:
          "Acme Locums here — still waiting on a couple of documents for your Regional Medical " +
          "packet. Reply STOP to opt out.",
        scheduledAt: offsetDays(-4),
        sentAt: offsetDays(-4),
      });
  }
}

async function seedJaneReference(params: {
  workspaceId: string;
  caseId: string;
}): Promise<void> {
  // rls: bypass — seed script.
  const existing = await db()
    .select({ id: schema.references.id })
    .from(schema.references)
    .where(
      and(
        eq(schema.references.caseId, params.caseId),
        eq(schema.references.email, "priya.rao@example.com"),
      ),
    )
    .limit(1);
  if (existing[0]) return;

  await db()
    .insert(schema.references)
    .values({
      workspaceId: params.workspaceId,
      caseId: params.caseId,
      name: "Dr. Priya Rao",
      relationship: "Attending physician",
      email: "priya.rao@example.com",
      status: "completed",
      respondedAt: offsetDays(-3),
      responseFields: {
        years_worked_together: 4,
        would_hire_again: true,
        notes: "Excellent clinical judgment.",
      },
    });
}

async function main(): Promise<void> {
  const workspace = await seedWorkspace();
  if (workspace.created) {
    await seedAudit({
      workspaceId: workspace.id,
      actorUserId: null,
      actorType: "system",
      action: "workspace.seeded",
      targetEntityType: "workspace",
      targetEntityId: workspace.id,
      after: { slug: WORKSPACE_SLUG, type: "agency" },
    });
  }

  const owner = await seedUser(OWNER_EMAIL);
  if (owner.created) {
    await seedAudit({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      actorType: "system",
      action: "user.seeded",
      targetEntityType: "user",
      targetEntityId: owner.id,
      after: { role: "owner" },
    });
  }

  const specialist = await seedUser(SPECIALIST_EMAIL);
  if (specialist.created) {
    await seedAudit({
      workspaceId: workspace.id,
      actorUserId: specialist.id,
      actorType: "system",
      action: "user.seeded",
      targetEntityType: "user",
      targetEntityId: specialist.id,
      after: { role: "specialist" },
    });
  }

  await seedMembership(owner.id, workspace.id, "owner");
  await seedMembership(specialist.id, workspace.id, "specialist");

  const facility = await seedFacility();
  const facilityProfile = await seedFacilityProfile(facility.id, workspace.id, owner.id);
  if (facilityProfile.created) {
    await seedAudit({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      actorType: "system",
      action: "facility_profile.approved",
      targetEntityType: "facility_profile",
      targetEntityId: facilityProfile.id,
      after: {
        facilityId: facility.id,
        facilityName: FACILITY_NAME,
        version: 1,
        status: "approved",
      },
    });
  }

  // -----------------------------------------------------------------------
  // Providers, grants, documents.
  // -----------------------------------------------------------------------
  const jane = await seedProvider({
    npi: "1234567890",
    firstName: "Jane",
    lastName: "Chen",
    email: "jane.chen@example.com",
    statesLicensed: ["TX"],
  });
  const marcus = await seedProvider({
    npi: "1234567891",
    firstName: "Marcus",
    lastName: "Reed",
    email: "marcus.reed@example.com",
    statesLicensed: ["TX", "NM"],
  });
  const aisha = await seedProvider({
    npi: "1234567892",
    firstName: "Aisha",
    lastName: "Patel",
    email: "aisha.patel@example.com",
    statesLicensed: ["TX"],
  });

  await seedGrant(jane.id, workspace.id, owner.id);
  await seedGrant(marcus.id, workspace.id, owner.id);
  await seedGrant(aisha.id, workspace.id, owner.id);

  // Jane — fully documented, ready for review.
  await seedDocument({
    providerId: jane.id,
    documentType: "medical_license",
    expiresAt: offsetDays(400),
    extractedFields: licenseFields(
      "TX-MD-778812",
      "TX",
      "Jane Chen, MD",
      offsetDays(400),
      "Emergency Medicine",
    ),
  });
  await seedDocument({
    providerId: jane.id,
    documentType: "dea",
    expiresAt: offsetDays(300),
    extractedFields: deaFields("BC1234563", "Jane Chen", offsetDays(300)),
  });
  await seedDocument({
    providerId: jane.id,
    documentType: "board_certification",
    expiresAt: offsetDays(800),
    extractedFields: boardCertFields("Jane Chen, MD", offsetDays(800)),
  });
  await seedDocument({
    providerId: jane.id,
    documentType: "bls",
    expiresAt: offsetDays(180),
    extractedFields: blsFields("Jane Chen", offsetDays(180)),
  });

  // Marcus — full doc set but license expires in 25 days (exercises the M5
  // 30-day expiration sweep).
  await seedDocument({
    providerId: marcus.id,
    documentType: "medical_license",
    expiresAt: offsetDays(25),
    extractedFields: licenseFields(
      "TX-MD-902144",
      "TX",
      "Marcus Reed, MD",
      offsetDays(25),
      "Emergency Medicine",
    ),
  });
  await seedDocument({
    providerId: marcus.id,
    documentType: "dea",
    expiresAt: offsetDays(400),
    extractedFields: deaFields("BM8452339", "Marcus Reed", offsetDays(400)),
  });
  await seedDocument({
    providerId: marcus.id,
    documentType: "board_certification",
    expiresAt: offsetDays(600),
    extractedFields: boardCertFields("Marcus Reed, MD", offsetDays(600)),
  });
  await seedDocument({
    providerId: marcus.id,
    documentType: "bls",
    expiresAt: offsetDays(120),
    extractedFields: blsFields("Marcus Reed", offsetDays(120)),
  });

  // Aisha — intentionally missing board_cert and bls so her case shows blockers.
  await seedDocument({
    providerId: aisha.id,
    documentType: "medical_license",
    expiresAt: offsetDays(500),
    extractedFields: licenseFields(
      "TX-MD-611037",
      "TX",
      "Aisha Patel, MD",
      offsetDays(500),
      "Emergency Medicine",
    ),
  });
  await seedDocument({
    providerId: aisha.id,
    documentType: "dea",
    expiresAt: offsetDays(450),
    extractedFields: deaFields("BP6631157", "Aisha Patel", offsetDays(450)),
  });

  // -----------------------------------------------------------------------
  // Cases.
  // -----------------------------------------------------------------------
  const janeCase = await seedCase({
    providerId: jane.id,
    providerName: "Jane Chen",
    workspaceId: workspace.id,
    facilityProfileId: facilityProfile.id,
    specialistId: specialist.id,
    status: "ready_for_review",
    openedAt: offsetDays(-14),
  });
  const marcusCase = await seedCase({
    providerId: marcus.id,
    providerName: "Marcus Reed",
    workspaceId: workspace.id,
    facilityProfileId: facilityProfile.id,
    specialistId: specialist.id,
    status: "awaiting_provider",
    openedAt: offsetDays(-7),
  });
  const aishaBlockers: Blocker[] = [
    {
      type: "missing_document",
      message: "board certification required",
      raisedAt: now.toISOString(),
      raisedBy: "agent",
    },
  ];
  const aishaCase = await seedCase({
    providerId: aisha.id,
    providerName: "Aisha Patel",
    workspaceId: workspace.id,
    facilityProfileId: facilityProfile.id,
    specialistId: specialist.id,
    status: "intake",
    openedAt: offsetDays(-2),
    blockers: aishaBlockers,
  });

  for (const caseRow of [janeCase, marcusCase, aishaCase]) {
    if (caseRow.created) {
      await seedAudit({
        workspaceId: workspace.id,
        actorUserId: null,
        actorType: "system",
        action: "case.seeded",
        targetEntityType: "case",
        targetEntityId: caseRow.id,
        after: { providerName: caseRow.providerName, status: caseRow.status },
      });
    }
  }

  // Outreach thread + messages for Marcus (awaiting_provider).
  await seedOutreachForMarcus({ workspaceId: workspace.id, caseId: marcusCase.id });

  // Reference for Jane.
  await seedJaneReference({ workspaceId: workspace.id, caseId: janeCase.id });

  const output: SeedOutput = {
    workspaceId: workspace.id,
    ownerUserId: owner.id,
    specialistUserId: specialist.id,
    facilityProfileId: facilityProfile.id,
    cases: [
      { providerName: janeCase.providerName, caseId: janeCase.id, status: janeCase.status },
      { providerName: marcusCase.providerName, caseId: marcusCase.id, status: marcusCase.status },
      { providerName: aishaCase.providerName, caseId: aishaCase.id, status: aishaCase.status },
    ],
  };

  console.log(JSON.stringify(output, null, 2));

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
