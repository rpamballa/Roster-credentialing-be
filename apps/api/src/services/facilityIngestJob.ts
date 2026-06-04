import { parseFacilityPacket } from "@cred/ai";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import { and, desc, eq } from "drizzle-orm";

/**
 * Inline facility-ingest advancer.
 *
 * Walks an ingest job from `uploaded` → `classifying` → `parsing` → `ready`
 * by fetching the uploaded PDF from object storage, handing it to Opus via
 * `parseFacilityPacket`, and writing a draft `facility_profile`. The
 * Temporal workflow `facilityIngest` does the equivalent work for the
 * email-in path; this function is the upload-flow equivalent until the
 * Temporal worker accepts a direct-upload input shape.
 *
 * Each lifecycle state is committed independently so the cockpit's status
 * poller sees real progress. Any failure flips the job to `failed` with a
 * bounded, non-PHI summary in `error`.
 */
export async function advanceIngestJobInline(jobId: string): Promise<void> {
  // rls: bypass — background advancer scoped by jobId; no PHI surfaced.
  const [job] = await db()
    .select()
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.id, jobId))
    .limit(1);
  if (!job) return;
  if (job.status !== "uploaded") return;
  if (!job.facilityId) {
    await markFailed(jobId, "ingest_job has no facility_id");
    return;
  }

  try {
    // ── classify (cheap signal; specialty hint already on the row) ──────
    await db()
      .update(schema.ingestJobs)
      .set({
        status: "classifying",
        detectedSpecialty: job.specialtyHint ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.ingestJobs.id, jobId));

    // ── fetch the uploaded packet from object storage ───────────────────
    const storage = getObjectStorage();
    const { url } = await storage.getSignedUrl({
      key: job.uploadedDocUri,
      expiresInSeconds: 10 * 60,
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`storage fetch ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString("base64");

    await db()
      .update(schema.ingestJobs)
      .set({ status: "parsing", updatedAt: new Date() })
      .where(eq(schema.ingestJobs.id, jobId));

    // ── parse with Opus ────────────────────────────────────────────────
    if (job.mimeType !== "application/pdf") {
      throw new Error(`unsupported mime type for inline parser: ${job.mimeType}`);
    }
    const requirements = await parseFacilityPacket({
      packetDocument: { base64, mediaType: "application/pdf" },
      workspaceId: job.workspaceId,
      relatedEntity: { type: "ingest_job", id: job.id },
    });

    // ── compute next version for this facility within the workspace ─────
    const prior = await db()
      .select({ version: schema.facilityProfiles.version })
      .from(schema.facilityProfiles)
      .where(
        and(
          eq(schema.facilityProfiles.facilityId, job.facilityId),
          eq(schema.facilityProfiles.workspaceId, job.workspaceId),
        ),
      )
      .orderBy(desc(schema.facilityProfiles.version))
      .limit(1);
    const nextVersion = (prior[0]?.version ?? 0) + 1;

    // ── persist the draft facility_profile ──────────────────────────────
    const [profile] = await db()
      .insert(schema.facilityProfiles)
      .values({
        facilityId: job.facilityId,
        workspaceId: job.workspaceId,
        version: nextVersion,
        status: "draft",
        sourcePacketUri: job.uploadedDocUri,
        requirements,
      })
      .returning({ id: schema.facilityProfiles.id });
    if (!profile) throw new Error("failed to write facility_profile");

    // ── flip the job to ready ──────────────────────────────────────────
    await db()
      .update(schema.ingestJobs)
      .set({
        status: "ready",
        facilityProfileId: profile.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.ingestJobs.id, jobId));

    await audit({
      workspaceId: job.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "facility_profile.drafted",
      targetEntityType: "facility_profile",
      targetEntityId: profile.id,
      after: {
        facilityId: job.facilityId,
        ingestJobId: job.id,
        version: nextVersion,
        requirementCounts: {
          documents: requirements.required_documents.length,
          verifications: requirements.required_verifications.length,
          privileges: requirements.privilege_delineations.reduce(
            (n, group) => n + group.privileges.length,
            0,
          ),
          attestations: requirements.attestations.length,
        },
      },
    });

    logger.info(
      { jobId, facilityProfileId: profile.id, version: nextVersion },
      "facility_ingest_ready",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "ingest_failed";
    logger.error({ jobId, err }, "facility_ingest_failed");
    await markFailed(jobId, message);
  }
}

async function markFailed(jobId: string, reason: string): Promise<void> {
  // rls: bypass — failure record off a background path.
  await db()
    .update(schema.ingestJobs)
    .set({
      // Bound the error column to a sane length; never include PHI.
      status: "failed",
      error: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(schema.ingestJobs.id, jobId));
}
