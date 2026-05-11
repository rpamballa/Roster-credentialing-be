import { parseFacilityPacket } from "@cred/ai";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import { and, desc, eq } from "drizzle-orm";

export interface FacilityIngestInput {
  inboundEmailId: string;
  workspaceId: string;
}

export async function parseAndDraftActivity(
  input: FacilityIngestInput,
): Promise<{ facilityProfileId: string }> {
  // rls: bypass — activity runs server-side off a workflow input.
  const [email] = await db()
    .select()
    .from(schema.inboundEmails)
    .where(eq(schema.inboundEmails.id, input.inboundEmailId))
    .limit(1);
  if (!email) throw new Error("inbound email not found");
  if (email.parsedAt) {
    logger.info({ inboundEmailId: input.inboundEmailId }, "facility_ingest_already_parsed");
    // Idempotent: find the existing draft and return it.
    const existing = await db()
      .select({ id: schema.facilityProfiles.id })
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.sourceEmailId, email.id))
      .limit(1);
    const existingId = existing[0]?.id;
    if (existingId) return { facilityProfileId: existingId };
  }

  const storage = getObjectStorage();
  const attachmentUrls = await Promise.all(
    (email.attachmentKeys ?? []).map((key) =>
      storage.getSignedUrl({ key, expiresInSeconds: 30 * 60 }).then((u) => u.url),
    ),
  );

  if (attachmentUrls.length === 0) {
    throw new Error("inbound email has no attachments to parse");
  }

  const requirements = await parseFacilityPacket({
    packetImageUrls: attachmentUrls,
    workspaceId: input.workspaceId,
    sourceEmailId: input.inboundEmailId,
  });

  // Create a placeholder facility row if one isn't already linked to this
  // inbound email. A specialist will rename / dedupe during review.
  const facilityName = email.subject?.trim() || `Facility from ${email.fromAddress}`;
  const [facility] = await db()
    .insert(schema.facilities)
    .values({ name: facilityName })
    .returning({ id: schema.facilities.id });
  if (!facility) throw new Error("failed to create facility");

  // Next version number for this facility within this workspace.
  const prior = await db()
    .select({ version: schema.facilityProfiles.version })
    .from(schema.facilityProfiles)
    .where(
      and(
        eq(schema.facilityProfiles.facilityId, facility.id),
        eq(schema.facilityProfiles.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(schema.facilityProfiles.version))
    .limit(1);
  const nextVersion = (prior[0]?.version ?? 0) + 1;

  const [profile] = await db()
    .insert(schema.facilityProfiles)
    .values({
      facilityId: facility.id,
      workspaceId: input.workspaceId,
      version: nextVersion,
      status: "draft",
      sourcePacketUri: email.rawPayloadUri,
      sourceEmailId: email.id,
      requirements,
    })
    .returning({ id: schema.facilityProfiles.id });
  if (!profile) throw new Error("failed to create facility profile");

  await db()
    .update(schema.inboundEmails)
    .set({ parsedAt: new Date(), parseStatus: "parsed" })
    .where(eq(schema.inboundEmails.id, email.id));

  await audit({
    workspaceId: input.workspaceId,
    actorUserId: null,
    actorType: "agent",
    action: "facility_profile.drafted",
    targetEntityType: "facility_profile",
    targetEntityId: profile.id,
    after: {
      facilityId: facility.id,
      sourceEmailId: email.id,
      version: nextVersion,
      requirementCounts: {
        documents: requirements.required_documents.length,
        verifications: requirements.required_verifications.length,
        attestations: requirements.attestations.length,
      },
    },
  });

  return { facilityProfileId: profile.id };
}
