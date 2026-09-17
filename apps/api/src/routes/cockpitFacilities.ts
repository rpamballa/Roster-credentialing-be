import { randomUUID } from "node:crypto";
import { convertDocxToHtml } from "@cred/ai";
import { db, schema, withTenancy } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireWriterOnMutations } from "../middleware/rbac.js";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import { advanceIngestJobInline } from "../services/facilityIngestJob.js";
import type { ApiBindings } from "../types.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MIME = "application/msword";

export const cockpitFacilityRoutes = new Hono<ApiBindings>();

cockpitFacilityRoutes.use(
  "/v1/cockpit/*",
  requireStaffAuth,
  requireTenancy,
  requireWriterOnMutations,
);

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

cockpitFacilityRoutes.post("/v1/cockpit/facilities/ingest/:jobId/uploaded", async (c) => {
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
});

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

// ─── GET /v1/cockpit/facility-profiles/:facilityProfileId/source.html ────
// Returns the source packet as inline-renderable HTML. Used by the review
// screen's DocumentViewer when the source is a Word document — react-pdf
// can't render .docx, so we mammoth-extract into styled HTML the FE
// injects with dangerouslySetInnerHTML.
//
// PDFs are served through the existing signed-URL path in the GraphQL
// resolver and don't reach here — we 415 them if they do.
cockpitFacilityRoutes.get(
  "/v1/cockpit/facility-profiles/:facilityProfileId/source.html",
  async (c) => {
    const facilityProfileId = c.req.param("facilityProfileId");

    const detail = await withTenancy(c.var.tenancy, async (tx) => {
      const [profile] = await tx
        .select({
          id: schema.facilityProfiles.id,
          sourcePacketUri: schema.facilityProfiles.sourcePacketUri,
        })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, facilityProfileId))
        .limit(1);
      if (!profile) return null;
      const [job] = await tx
        .select({ mimeType: schema.ingestJobs.mimeType })
        .from(schema.ingestJobs)
        .where(eq(schema.ingestJobs.facilityProfileId, profile.id))
        .limit(1);
      return { profile, mimeType: job?.mimeType ?? null };
    });
    if (!detail) return c.notFound();
    if (!detail.profile.sourcePacketUri) return c.notFound();

    const mime = detail.mimeType;
    if (mime !== DOCX_MIME && mime !== DOC_MIME) {
      return c.json(
        {
          type: "https://errors.cred/facility/source-not-html",
          title: "Source is not a Word document",
          status: 415,
          detail:
            "Only .docx / .doc sources are rendered as HTML. PDF sources use the signed URL directly.",
          instance: c.var.requestId,
        },
        415,
      );
    }

    try {
      // Round-trip via a signed GET URL so we don't need to give the api
      // container direct object-storage credentials for reads.
      const signed = await getObjectStorage().getSignedUrl({
        key: detail.profile.sourcePacketUri,
        expiresInSeconds: 5 * 60,
      });
      const resp = await fetch(signed.url);
      if (!resp.ok) throw new Error(`storage fetch ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const { html, warnings } = await convertDocxToHtml(buffer);
      if (warnings.length > 0) {
        logger.info(
          { facilityProfileId, warnings: warnings.length },
          "docx_html_conversion_warnings",
        );
      }
      // Wrap in a minimal safe scaffold — no scripts, no external
      // references. The FE injects this inside a scoped container so
      // its own tokens control the outer chrome.
      return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
    } catch (err) {
      logger.error({ err, facilityProfileId }, "facility_source_html_conversion_failed");
      return c.json(
        {
          type: "https://errors.cred/facility/source-conversion-failed",
          title: "Could not convert Word document to HTML",
          status: 500,
          instance: c.var.requestId,
        },
        500,
      );
    }
  },
);

// ─── PATCH /v1/cockpit/facility-profiles/:facilityProfileId/reviewed-fields ─
// Full-list replacement of the review marks. The FE sends every currently-
// reviewed key on each write — small payload, avoids add/remove races, and
// makes "reset all" trivial from the client side.
const ReviewedFieldsBody = z.object({
  keys: z.array(z.string().min(1).max(200)).max(500),
});

cockpitFacilityRoutes.patch(
  "/v1/cockpit/facility-profiles/:facilityProfileId/reviewed-fields",
  zValidator("json", ReviewedFieldsBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const facilityProfileId = c.req.param("facilityProfileId");
    const { keys } = c.req.valid("json");

    const updated = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .update(schema.facilityProfiles)
        .set({ reviewedFieldKeys: keys, updatedAt: new Date() })
        .where(
          and(
            eq(schema.facilityProfiles.id, facilityProfileId),
            eq(schema.facilityProfiles.workspaceId, c.var.tenancy.workspaceId),
          ),
        )
        .returning({
          id: schema.facilityProfiles.id,
          reviewedFieldKeys: schema.facilityProfiles.reviewedFieldKeys,
        });
      return row ?? null;
    });
    if (!updated) return notFoundResponse(c);

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "facility_profile.reviewed_fields_updated",
      targetEntityType: "facility_profile",
      targetEntityId: facilityProfileId,
      after: { count: keys.length },
      requestId: c.var.requestId,
    });

    return c.json({ reviewedFieldKeys: updated.reviewedFieldKeys });
  },
);

cockpitFacilityRoutes.post("/v1/cockpit/facilities/:facilityProfileId/approve", async (c) => {
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
});

function notFoundResponse(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}
