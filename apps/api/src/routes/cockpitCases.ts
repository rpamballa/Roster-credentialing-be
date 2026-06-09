import { issueCaseAccessToken, issueReferenceToken } from "@cred/auth";
import { env } from "@cred/config";
import { schema, withTenancy } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireWriterOnMutations } from "../middleware/rbac.js";
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

cockpitCaseRoutes.use(
  "/v1/cockpit/*",
  requireStaffAuth,
  requireTenancy,
  requireWriterOnMutations,
);

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

    const detail = await withTenancy(c.var.tenancy, async (tx) => {
      const [row] = await tx
        .select({
          id: schema.references.id,
          name: schema.references.name,
          email: schema.references.email,
          status: schema.references.status,
        })
        .from(schema.references)
        .where(
          and(eq(schema.references.id, referenceId), eq(schema.references.caseId, caseId)),
        )
        .limit(1);
      return row ?? null;
    });
    if (!detail) return notFoundResponse(c);

    // Mint a single-use token so the email contains an actionable link to the
    // public reference form. The watcher script greps for `magic_link.issued`
    // and extracts the URL for the tester.
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const { token } = await issueReferenceToken({
      referenceId,
      workspaceId: c.var.tenancy.workspaceId,
      expiresAt,
    });
    const url = new URL(`/reference/${token}`, env().WEB_PUBLIC_URL).toString();

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "reference.resent",
      targetEntityType: "reference",
      targetEntityId: referenceId,
      after: { caseId, url, expiresAt: expiresAt.toISOString() },
      requestId: c.var.requestId,
    });
    // Watcher-shaped log line so scripts/magic-link-watch.sh surfaces the URL.
    logger.info(
      {
        action: "reference.magic_link.issued",
        caseId,
        referenceId,
        email: detail.email ?? null,
        url,
      },
      "reference_magic_link_issued",
    );

    return c.json({ url, expiresAt: expiresAt.toISOString() });
  },
);

// ─── POST /v1/cockpit/cases/:caseId/invite-provider ───────────────────
// Mint a fresh case-access token for the provider on this case, log a
// magic-link-shaped audit row so scripts/magic-link-watch.sh surfaces the
// URL, and return the invite URL to the cockpit UI for clipboard / share.
//
// The audit action MATCHES the format the watcher script greps for —
// `magic_link.issued` substring + `url` + `email` fields — so we ship a
// single watcher binary across all magic-link surfaces.
cockpitCaseRoutes.post("/v1/cockpit/cases/:caseId/invite-provider", async (c) => {
  const auth = c.var.staffAuth;
  const caseId = c.req.param("caseId");

  const detail = await withTenancy(c.var.tenancy, async (tx) => {
    const [row] = await tx
      .select({
        id: schema.cases.id,
        providerId: schema.cases.providerId,
        status: schema.cases.status,
      })
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);
    if (!row) return null;
    const [provider] = await tx
      .select({
        email: schema.providers.email,
        firstName: schema.providers.firstName,
        lastName: schema.providers.lastName,
      })
      .from(schema.providers)
      .where(eq(schema.providers.id, row.providerId))
      .limit(1);
    return { caseRow: row, provider: provider ?? null };
  });

  if (!detail) return notFoundResponse(c);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const { token } = await issueCaseAccessToken({
    caseId: detail.caseRow.id,
    providerId: detail.caseRow.providerId,
    workspaceId: c.var.tenancy.workspaceId,
    expiresAt,
    issuedByUserId: auth.session.userId,
  });

  const url = new URL(`/invite/${token}`, env().WEB_PUBLIC_URL).toString();

  await audit({
    workspaceId: c.var.tenancy.workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "auth.provider_invite.magic_link.issued",
    targetEntityType: "case",
    targetEntityId: detail.caseRow.id,
    after: {
      providerId: detail.caseRow.providerId,
      email: detail.provider?.email ?? null,
      fullName: detail.provider
        ? `${detail.provider.firstName} ${detail.provider.lastName}`.trim()
        : null,
      url,
      expiresAt: expiresAt.toISOString(),
    },
    requestId: c.var.requestId,
  });

  // scripts/magic-link-watch.sh in roster-credentialing-deploy greps the
  // api log for the `magic_link.issued` substring and pulls "url" / "email"
  // out of the line. The audit() call above doesn't include the url in its
  // log emission, so we explicitly log a watcher-shaped line here. Email is
  // redacted at the pino layer (PHI), which is fine — the script falls back
  // to "unknown" when email is missing and the URL is the actionable bit.
  logger.info(
    {
      action: "auth.provider_invite.magic_link.issued",
      caseId: detail.caseRow.id,
      providerId: detail.caseRow.providerId,
      url,
    },
    "provider_invite_magic_link_issued",
  );

  return c.json({ url, expiresAt: expiresAt.toISOString() });
});

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
