import { randomUUID } from "node:crypto";
import { db, schema, withTenancy } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import { advanceIngestJobInline } from "../services/facilityIngestJob.js";
import type { ApiBindings } from "../types.js";

export const cockpitFacilityRoutes = new Hono<ApiBindings>();

cockpitFacilityRoutes.use("/v1/cockpit/*", requireStaffAuth, requireTenancy);

const INGEST_ACCEPTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
] as const;
const MAX_INGEST_BYTES = 50 * 1024 * 1024;

const SignIngestBody = z
  .object({
    facilityId: z.string().min(1).optional(),
    facilityName: z.string().min(1).max(200).optional(),
    specialtyHint: z.string().min(1).max(120).optional(),
    mimeType: z.enum(INGEST_ACCEPTED_MIME),
    sizeBytes: z.number().int().positive().max(MAX_INGEST_BYTES),
  })
  .refine((v) => v.facilityId || v.facilityName, {
    message: "Provide either facilityId or facilityName.",
  });

cockpitFacilityRoutes.post(
  "/v1/cockpit/facilities/ingest/sign-upload",
  zValidator("json", SignIngestBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const workspaceId = c.var.tenancy.workspaceId;
    const body = c.req.valid("json");

    // Resolve or create the facility. New facilities are global per SPEC §5.1
    // so this insert is intentionally not under the workspace RLS predicate.
    let facilityId = body.facilityId ?? null;
    if (!facilityId) {
      const [created] = await db()
        .insert(schema.facilities)
        .values({ name: body.facilityName! })
        .returning({ id: schema.facilities.id });
      if (!created) {
        return c.json(
          {
            type: "https://errors.cred/ingest/facility-create-failed",
            title: "Failed to create facility",
            status: 500,
            instance: c.var.requestId,
          },
          500,
        );
      }
      facilityId = created.id;
    }

    const key = `ingest/${workspaceId}/${randomUUID()}`;
    const signed = await getObjectStorage().putSignedUrl({
      key,
      contentType: body.mimeType,
      expiresInSeconds: 15 * 60,
    });

    const jobId = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .insert(schema.ingestJobs)
        .values({
          workspaceId,
          facilityId,
          uploadedDocUri: key,
          mimeType: body.mimeType,
          sizeBytes: body.sizeBytes,
          specialtyHint: body.specialtyHint ?? null,
          status: "uploaded",
          createdBy: auth.session.userId,
        })
        .returning({ id: schema.ingestJobs.id });
      if (!row) throw new Error("failed to create ingest job");
      return row.id;
    });

    await audit({
      workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "facility_ingest.upload_signed",
      targetEntityType: "ingest_job",
      targetEntityId: jobId,
      after: { facilityId, sizeBytes: body.sizeBytes, mimeType: body.mimeType },
      requestId: c.var.requestId,
    });

    return c.json({
      ingestJobId: jobId,
      uploadUrl: signed.url,
      headers: signed.headers,
      maxBytes: MAX_INGEST_BYTES,
    });
  },
);

cockpitFacilityRoutes.post(
  "/v1/cockpit/facilities/ingest/:jobId/uploaded",
  async (c) => {
    const auth = c.var.staffAuth;
    const jobId = c.req.param("jobId");

    const job = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.ingestJobs)
        .where(eq(schema.ingestJobs.id, jobId))
        .limit(1);
      return row ?? null;
    });
    if (!job) return notFoundResponse(c);

    // Kick off the Temporal workflow when configured; otherwise advance the
    // job inline so the cockpit's status poller sees progress. The activity
    // already exists (apps/workers/src/activities/facilityIngest.ts) but is
    // wired to inbound emails. Until the worker accepts a direct ingest
    // input, fall through to the inline advancer.
    advanceIngestJobInline(jobId).catch((err: unknown) =>
      logger.error({ jobId, err }, "ingest_job_inline_advance_failed"),
    );

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "facility_ingest.uploaded",
      targetEntityType: "ingest_job",
      targetEntityId: jobId,
      requestId: c.var.requestId,
    });

    return c.json({ ingestJobId: jobId, status: job.status });
  },
);

cockpitFacilityRoutes.get("/v1/cockpit/facilities/ingest/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await withTenancy(c.var.tenancy, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.ingestJobs)
      .where(eq(schema.ingestJobs.id, jobId))
      .limit(1);
    return row ?? null;
  });
  if (!job) return notFoundResponse(c);

  return c.json({
    ingestJobId: job.id,
    status: job.status,
    detectedSpecialty: job.detectedSpecialty,
    facilityProfileId: job.facilityProfileId,
    error: job.error,
  });
});

cockpitFacilityRoutes.post(
  "/v1/cockpit/facilities/:facilityProfileId/approve",
  async (c) => {
    const auth = c.var.staffAuth;
    const facilityProfileId = c.req.param("facilityProfileId");

    const updated = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.facilityProfiles)
        .where(
          and(
            eq(schema.facilityProfiles.id, facilityProfileId),
            eq(schema.facilityProfiles.workspaceId, c.var.tenancy.workspaceId),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (row.status !== "draft" && row.status !== "in_review") {
        return { conflict: true as const, status: row.status };
      }
      const [next] = await tx
        .update(schema.facilityProfiles)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedBy: auth.session.userId,
          updatedAt: new Date(),
        })
        .where(eq(schema.facilityProfiles.id, facilityProfileId))
        .returning({
          id: schema.facilityProfiles.id,
          version: schema.facilityProfiles.version,
          requirements: schema.facilityProfiles.requirements,
        });
      if (next) {
        await tx.insert(schema.facilityProfileVersions).values({
          facilityProfileId: next.id,
          workspaceId: c.var.tenancy.workspaceId,
          version: next.version,
          requirements: next.requirements,
          approvedAt: new Date(),
          approvedBy: auth.session.userId,
        });
      }
      return { conflict: false as const, before: row.status };
    });

    if (updated === null) return notFoundResponse(c);
    if (updated.conflict)
      return c.json(
        {
          type: "https://errors.cred/cockpit/facility_profile_not_pending",
          title: "facility profile not pending review",
          status: 409,
          instance: c.var.requestId,
        },
        409,
      );

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "facility_profile.approved",
      targetEntityType: "facility_profile",
      targetEntityId: facilityProfileId,
      before: { status: updated.before },
      after: { status: "approved" },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

function notFoundResponse(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}
