// Test helpers for the ingest package. Keep seed utilities in one
// place so each test file reads top-down.
import { randomUUID } from "node:crypto";
import { db } from "@cred/db";
import {
  caseNotes,
  cases,
  facilities,
  facilityProfiles,
  outreachMessages,
  outreachThreads,
  providerWorkspaceGrants,
  providers,
  verifications,
  workspaces,
} from "@cred/db/schema";

export async function seedWorkspace(opts: { slug?: string } = {}): Promise<string> {
  const slug = opts.slug ?? `ws-${randomUUID().slice(0, 6)}`;
  const [row] = await db()
    .insert(workspaces)
    .values({ type: "agency", name: slug, slug, isPlatformDefault: false })
    .returning({ id: workspaces.id });
  if (!row) throw new Error("workspace insert failed");
  return row.id;
}

export interface SeedProviderInput {
  firstName: string;
  lastName: string;
  npi?: string;
  email?: string;
  phone?: string;
  specialties?: string[];
  statesLicensed?: string[];
}

export async function seedProvider(workspaceId: string, input: SeedProviderInput): Promise<string> {
  const values: typeof providers.$inferInsert = {
    firstName: input.firstName,
    lastName: input.lastName,
    ...(input.npi !== undefined ? { npi: input.npi } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    specialties: input.specialties ?? [],
    statesLicensed: input.statesLicensed ?? [],
  };
  const [row] = await db().insert(providers).values(values).returning({ id: providers.id });
  if (!row) throw new Error("provider insert failed");
  await db().insert(providerWorkspaceGrants).values({ providerId: row.id, workspaceId });
  return row.id;
}

export async function seedFacility(input: { name: string }): Promise<string> {
  const [row] = await db()
    .insert(facilities)
    .values({ name: input.name })
    .returning({ id: facilities.id });
  if (!row) throw new Error("facility insert failed");
  return row.id;
}

export async function seedFacilityProfile(opts: {
  workspaceId: string;
  facilityId: string;
}): Promise<string> {
  const [row] = await db()
    .insert(facilityProfiles)
    .values({
      facilityId: opts.facilityId,
      workspaceId: opts.workspaceId,
      version: 1,
      status: "approved",
      // Minimal shape — the ingest reader does not touch this blob.
      // Cast through unknown because FacilityRequirements comes from
      // @cred/types/domain and we don't want to depend on it in the
      // ingest test module.
      requirements: {} as never,
    })
    .returning({ id: facilityProfiles.id });
  if (!row) throw new Error("facility profile insert failed");
  return row.id;
}

export async function seedCase(opts: {
  workspaceId: string;
  providerId: string;
  facilityProfileId?: string;
  specialty?: string;
  targetSubmissionDate?: string;
}): Promise<string> {
  const values: typeof cases.$inferInsert = {
    workspaceId: opts.workspaceId,
    providerId: opts.providerId,
    specialty: opts.specialty ?? "anesthesiology",
    purpose: "initial_appointment",
    ...(opts.facilityProfileId !== undefined ? { facilityProfileId: opts.facilityProfileId } : {}),
    ...(opts.targetSubmissionDate !== undefined
      ? { targetSubmissionDate: opts.targetSubmissionDate }
      : {}),
  };
  const [row] = await db().insert(cases).values(values).returning({ id: cases.id });
  if (!row) throw new Error("case insert failed");
  return row.id;
}

export async function seedVerification(opts: {
  workspaceId: string;
  providerId: string;
  type: string;
  state?: string;
  status?: string;
  licenseNumber?: string;
}): Promise<void> {
  await db()
    .insert(verifications)
    .values({
      workspaceId: opts.workspaceId,
      providerId: opts.providerId,
      type: opts.type,
      source: "test",
      ...(opts.state !== undefined ? { state: opts.state } : {}),
      ...(opts.licenseNumber !== undefined ? { licenseNumber: opts.licenseNumber } : {}),
      status: opts.status ?? "active",
      verifiedAt: new Date(),
    });
}

export async function seedCaseNote(opts: {
  workspaceId: string;
  caseId: string;
  body: string;
  deletedAt?: Date | null;
}): Promise<string> {
  const [row] = await db()
    .insert(caseNotes)
    .values({
      workspaceId: opts.workspaceId,
      caseId: opts.caseId,
      body: opts.body,
      ...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
    })
    .returning({ id: caseNotes.id });
  if (!row) throw new Error("case note insert failed");
  return row.id;
}

export async function seedOutreachEmail(opts: {
  workspaceId: string;
  caseId: string;
  providerEmail?: string;
  providerName?: string;
  body?: string;
}): Promise<string> {
  const [thread] = await db()
    .insert(outreachThreads)
    .values({
      workspaceId: opts.workspaceId,
      caseId: opts.caseId,
      recipientKind: "provider",
      ...(opts.providerName !== undefined ? { recipientName: opts.providerName } : {}),
      ...(opts.providerEmail !== undefined ? { recipientEmail: opts.providerEmail } : {}),
    })
    .returning({ id: outreachThreads.id });
  if (!thread) throw new Error("outreach thread insert failed");
  const [msg] = await db()
    .insert(outreachMessages)
    .values({
      threadId: thread.id,
      workspaceId: opts.workspaceId,
      channel: "email",
      direction: "out",
      body: opts.body ?? "hello from recruiter",
      sentAt: new Date(),
    })
    .returning({ id: outreachMessages.id });
  if (!msg) throw new Error("outreach message insert failed");
  return msg.id;
}
