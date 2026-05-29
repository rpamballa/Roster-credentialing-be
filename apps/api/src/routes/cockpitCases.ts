import { schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import type { ApiBindings } from "../types.js";

function notFoundResponse(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}

function conflictResponse(c: Context<ApiBindings>, code: string): Response {
  return c.json(
    {
      type: `https://errors.cred/cockpit/${code}`,
      title: code.replace(/_/g, " "),
      status: 409,
      instance: c.var.requestId,
    },
    409,
  );
}

// Cockpit case action endpoints. All return 204 on success and audit-log
// the mutation. The frontend BFFs in apps/web/app/api/cockpit/cases/* call
// these directly.
export const cockpitCaseRoutes = new Hono<ApiBindings>();

cockpitCaseRoutes.use("/v1/cockpit/*", requireStaffAuth, requireTenancy);

const NudgeBody = z.object({
  channel: z.enum(["sms", "email", "sms_and_email"]),
  message: z.string().min(1).max(320).optional(),
});

cockpitCaseRoutes.post(
  "/v1/cockpit/cases/:caseId/nudge",
  zValidator("json", NudgeBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    const exists = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select({ id: schema.cases.id })
        .from(schema.cases)
        .where(eq(schema.cases.id, caseId))
        .limit(1);
      return Boolean(row);
    });
    if (!exists) return notFoundResponse(c);

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "case.nudge_sent",
      targetEntityType: "case",
      targetEntityId: caseId,
      after: { channel: body.channel, hasMessageOverride: typeof body.message === "string" },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

cockpitCaseRoutes.post("/v1/cockpit/cases/:caseId/mark-ready", async (c) => {
  const auth = c.var.staffAuth;
  const caseId = c.req.param("caseId");

  const before = await withTenancy(c.var.tenancy, async (tx) => {
    const [row] = await tx
      .select({ status: schema.cases.status })
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);
    if (!row) return null;
    await tx
      .update(schema.cases)
      .set({ status: "ready_for_review" })
      .where(eq(schema.cases.id, caseId));
    return row.status;
  });
  if (before === null) return notFoundResponse(c);

  await audit({
    workspaceId: c.var.tenancy.workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "case.marked_ready",
    targetEntityType: "case",
    targetEntityId: caseId,
    before: { status: before },
    after: { status: "ready_for_review" },
    requestId: c.var.requestId,
  });

  return new Response(null, { status: 204 });
});

const SubmitBody = z.object({
  confirmedKeys: z.array(z.string().min(1)).min(1).max(60).optional(),
});

cockpitCaseRoutes.post(
  "/v1/cockpit/cases/:caseId/submit",
  zValidator("json", SubmitBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    const before = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select({ status: schema.cases.status, submittedAt: schema.cases.submittedAt })
        .from(schema.cases)
        .where(eq(schema.cases.id, caseId))
        .limit(1);
      if (!row) return null;
      if (row.submittedAt) return { conflict: true as const };
      await tx
        .update(schema.cases)
        .set({ status: "submitted", submittedAt: new Date() })
        .where(eq(schema.cases.id, caseId));
      return { conflict: false as const, status: row.status };
    });
    if (before === null) return notFoundResponse(c);
    if (before.conflict) return conflictResponse(c, "case_already_submitted");

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "case.submitted",
      targetEntityType: "case",
      targetEntityId: caseId,
      before: { status: before.status },
      after: { confirmedKeyCount: body.confirmedKeys?.length ?? 0 },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

const EscalateBody = z.object({
  reason: z.enum([
    "stuck_with_provider",
    "stuck_with_reference",
    "facility_mismatch",
    "compliance_question",
    "other",
  ]),
  details: z.string().min(1).max(500),
});

cockpitCaseRoutes.post(
  "/v1/cockpit/cases/:caseId/escalate",
  zValidator("json", EscalateBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    const exists = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select({ id: schema.cases.id })
        .from(schema.cases)
        .where(eq(schema.cases.id, caseId))
        .limit(1);
      return Boolean(row);
    });
    if (!exists) return notFoundResponse(c);

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "case.escalated",
      targetEntityType: "case",
      targetEntityId: caseId,
      after: { reason: body.reason },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

const ReuploadBody = z.object({
  requirementKey: z.string().min(1).max(100),
  reason: z.string().min(1).max(500),
});

cockpitCaseRoutes.post(
  "/v1/cockpit/cases/:caseId/request-reupload",
  zValidator("json", ReuploadBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    const exists = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select({ id: schema.cases.id })
        .from(schema.cases)
        .where(eq(schema.cases.id, caseId))
        .limit(1);
      return Boolean(row);
    });
    if (!exists) return notFoundResponse(c);

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "case.reupload_requested",
      targetEntityType: "case",
      targetEntityId: caseId,
      after: { requirementKey: body.requirementKey },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

cockpitCaseRoutes.post(
  "/v1/cockpit/cases/:caseId/references/:referenceId/resend",
  async (c) => {
    const auth = c.var.staffAuth;
    const caseId = c.req.param("caseId");
    const referenceId = c.req.param("referenceId");

    const exists = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select({ id: schema.references.id })
        .from(schema.references)
        .where(
          and(eq(schema.references.id, referenceId), eq(schema.references.caseId, caseId)),
        )
        .limit(1);
      return Boolean(row);
    });
    if (!exists) return notFoundResponse(c);

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "reference.resent",
      targetEntityType: "reference",
      targetEntityId: referenceId,
      after: { caseId },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

const BulkNudgeBody = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(100),
  message: z.string().min(1).max(320),
});

cockpitCaseRoutes.post(
  "/v1/cockpit/bulk-nudge",
  zValidator("json", BulkNudgeBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const body = c.req.valid("json");

    // Filter to caseIds that belong to the workspace; silently drop the rest
    // so a partial payload doesn't 404 the whole batch.
    const targets = await withTenancy(c.var.tenancy, async (tx) => {
      const rows = await tx.select({ id: schema.cases.id }).from(schema.cases);
      const inSet = new Set(body.caseIds);
      return rows.map((r) => r.id).filter((id) => inSet.has(id));
    });

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "case.bulk_nudge_sent",
      targetEntityType: "case",
      targetEntityId: targets[0] ?? "00000000-0000-0000-0000-000000000000",
      after: { requestedCount: body.caseIds.length, dispatchedCount: targets.length },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);
