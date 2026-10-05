import { type Tx, schema } from "@cred/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordCaseStatusEvent } from "./caseStatusEvents.js";

/**
 * Shared case-create primitive. Used by:
 *   - POST /v1/cockpit/cases (staff opens a case for an existing provider)
 *   - POST /v1/cockpit/providers/invite (staff can tick "also open a case"
 *     when sending an invite — the provider row has already been materialized
 *     by ensureProviderAccount, so we can create the case in the same tx)
 *
 * MUST be called inside a withTenancy transaction — the inserts here rely
 * on the tx's workspace guards.
 *
 * Preserved behaviours:
 *   - Facility must have an approved profile in this workspace; the case
 *     is pinned to that profile's id + version at create time so a later
 *     profile edit doesn't move the goalposts on an in-flight case.
 *   - If an open case already exists for (provider, facility-profile) it
 *     is NOT recreated — the caller gets back `case_already_open` with the
 *     existing caseId.
 *   - A `case_status_events` row is written for the intake-start transition
 *     so the timeline component has history on day one.
 */
export interface CreateCaseParams {
  providerId: string;
  facilityId: string;
  specialty: string;
  purpose: "initial_appointment" | "reappointment" | "privileging";
  targetSubmissionDate?: string | null;
  actorUserId: string;
}

export type CreateCaseResult =
  | {
      kind: "ok";
      caseId: string;
      facilityProfileId: string;
      facilityProfileVersion: number;
    }
  | { kind: "provider_not_in_workspace" }
  | { kind: "no_approved_profile" }
  | { kind: "case_already_open"; caseId: string };

export async function createCaseForProvider(
  tx: Tx,
  workspaceId: string,
  params: CreateCaseParams,
): Promise<CreateCaseResult> {
  const [grant] = await tx
    .select({ providerId: schema.providerWorkspaceGrants.providerId })
    .from(schema.providerWorkspaceGrants)
    .where(
      and(
        eq(schema.providerWorkspaceGrants.providerId, params.providerId),
        eq(schema.providerWorkspaceGrants.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!grant) return { kind: "provider_not_in_workspace" };

  const approvedRows = await tx
    .select({
      profileId: schema.facilityProfiles.id,
      version: schema.facilityProfiles.version,
    })
    .from(schema.facilityProfiles)
    .where(
      and(
        eq(schema.facilityProfiles.facilityId, params.facilityId),
        eq(schema.facilityProfiles.workspaceId, workspaceId),
        eq(schema.facilityProfiles.status, "approved"),
      ),
    )
    .orderBy(desc(schema.facilityProfiles.version))
    .limit(1);
  const approved = approvedRows[0];
  if (!approved) return { kind: "no_approved_profile" };

  const [existingOpen] = await tx
    .select({ id: schema.cases.id })
    .from(schema.cases)
    .where(
      and(
        eq(schema.cases.workspaceId, workspaceId),
        eq(schema.cases.providerId, params.providerId),
        eq(schema.cases.facilityProfileId, approved.profileId),
        sql`${schema.cases.status} NOT IN ('submitted','completed','withdrawn')`,
      ),
    )
    .limit(1);
  if (existingOpen) return { kind: "case_already_open", caseId: existingOpen.id };

  const [row] = await tx
    .insert(schema.cases)
    .values({
      workspaceId,
      providerId: params.providerId,
      facilityProfileId: approved.profileId,
      facilityProfileVersion: String(approved.version),
      specialty: params.specialty,
      purpose: params.purpose,
      status: "intake",
      targetSubmissionDate: params.targetSubmissionDate ?? null,
      assignedSpecialistId: params.actorUserId,
    })
    .returning({ id: schema.cases.id });
  if (!row) throw new Error("case insert failed");

  await recordCaseStatusEvent(tx, {
    caseId: row.id,
    workspaceId,
    fromStatus: null,
    toStatus: "intake",
    actorUserId: params.actorUserId,
  });

  return {
    kind: "ok",
    caseId: row.id,
    facilityProfileId: approved.profileId,
    facilityProfileVersion: approved.version,
  };
}
