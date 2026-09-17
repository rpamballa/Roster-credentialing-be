import { issueCaseAccessToken, issueReferenceToken, sendEmail } from "@cred/auth";
import { env } from "@cred/config";
import { schema, withTenancy } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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

cockpitCaseRoutes.use("/v1/cockpit/*", requireStaffAuth, requireTenancy, requireWriterOnMutations);

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

cockpitCaseRoutes.post("/v1/cockpit/cases/:caseId/references/:referenceId/resend", async (c) => {
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
      .where(and(eq(schema.references.id, referenceId), eq(schema.references.caseId, caseId)))
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
});

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

  // Deliver the invite to the provider directly. `sendEmail` is a no-op in
  // non-production or when RESEND_API_KEY is unset — the URL still comes
  // back in the response so the specialist can share via clipboard as a
  // fallback. Wrapped in try/catch so a Resend outage never blocks the
  // cockpit action; the specialist keeps their clipboard flow.
  if (detail.provider?.email) {
    try {
      const greeting = detail.provider.firstName?.trim() || "there";
      await sendEmail({
        to: detail.provider.email,
        subject: "Roster Healthcare — start your credentialing packet",
        text:
          `Hi ${greeting},\n\n` +
          `You've been invited to complete a credentialing case with Roster Healthcare. ` +
          `Get started here:\n\n${url}\n\n` +
          `This link expires in 7 days and can only be used from this device.\n\n` +
          "— The Roster Healthcare team",
      });
      logger.info(
        { caseId: detail.caseRow.id, providerId: detail.caseRow.providerId },
        "provider_invite_email_sent",
      );
    } catch (err) {
      logger.error(
        { err, caseId: detail.caseRow.id, providerId: detail.caseRow.providerId },
        "provider_invite_email_send_failed",
      );
    }
  }

  return c.json({ url, expiresAt: expiresAt.toISOString() });
});

const BulkNudgeBody = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(100),
  message: z.string().min(1).max(320),
});

cockpitCaseRoutes.post("/v1/cockpit/bulk-nudge", zValidator("json", BulkNudgeBody), async (c) => {
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
});

// ─── GET /v1/cockpit/cases/new/lookups ────────────────────────────────────
// Populates the "New case" dialog. Returns:
//   - providers: workspace-scoped (has a provider_workspace_grants row)
//   - facilities: those with at least one approved facility_profile in this
//     workspace, plus the id + version of that approved profile so the
//     new case can pin to it.
// Colocated with case creation because it exists solely to feed that dialog.
cockpitCaseRoutes.get("/v1/cockpit/cases/new/lookups", async (c) => {
  const workspaceId = c.var.tenancy.workspaceId;

  const [providers, facilities] = await withTenancy(c.var.tenancy, async (tx) => {
    const providerRows = await tx
      .select({
        id: schema.providers.id,
        firstName: schema.providers.firstName,
        lastName: schema.providers.lastName,
        email: schema.providers.email,
      })
      .from(schema.providers)
      .innerJoin(
        schema.providerWorkspaceGrants,
        eq(schema.providerWorkspaceGrants.providerId, schema.providers.id),
      )
      .where(eq(schema.providerWorkspaceGrants.workspaceId, workspaceId))
      .orderBy(schema.providers.lastName, schema.providers.firstName);

    // For facilities we want one row per facility, with the latest approved
    // profile pinned. Group in-memory since we only need the max version.
    const profileRows = await tx
      .select({
        profileId: schema.facilityProfiles.id,
        facilityId: schema.facilityProfiles.facilityId,
        version: schema.facilityProfiles.version,
        status: schema.facilityProfiles.status,
      })
      .from(schema.facilityProfiles)
      .where(
        and(
          eq(schema.facilityProfiles.workspaceId, workspaceId),
          eq(schema.facilityProfiles.status, "approved"),
        ),
      );

    if (profileRows.length === 0) return [providerRows, []] as const;

    const facilityIds = [...new Set(profileRows.map((r) => r.facilityId))];
    const facilityRows = await tx
      .select({ id: schema.facilities.id, name: schema.facilities.name })
      .from(schema.facilities)
      .where(inArray(schema.facilities.id, facilityIds));
    const nameByFacility = new Map(facilityRows.map((r) => [r.id, r.name]));

    const latestByFacility = new Map<string, { profileId: string; version: number }>();
    for (const row of profileRows) {
      const current = latestByFacility.get(row.facilityId);
      if (!current || row.version > current.version) {
        latestByFacility.set(row.facilityId, {
          profileId: row.profileId,
          version: row.version,
        });
      }
    }

    const facilityList = [...latestByFacility.entries()]
      .map(([facilityId, latest]) => ({
        id: facilityId,
        name: nameByFacility.get(facilityId) ?? "Unknown facility",
        facilityProfileId: latest.profileId,
        facilityProfileVersion: latest.version,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return [providerRows, facilityList] as const;
  });

  return c.json({
    providers: providers.map((p) => ({
      id: p.id,
      fullName: `${p.firstName} ${p.lastName}`.trim(),
      email: p.email,
    })),
    facilities,
  });
});

// ─── POST /v1/cockpit/cases ───────────────────────────────────────────────
// Create a new credentialing case (staff-driven matching). Pins the case to
// the current approved profile version so a later profile edit doesn't move
// the goalposts on an in-flight case.
const CreateCaseBody = z.object({
  providerId: z.string().uuid(),
  facilityId: z.string().uuid(),
  specialty: z.string().min(1).max(120),
  targetSubmissionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  purpose: z
    .enum(["initial_appointment", "reappointment", "privileging"])
    .default("initial_appointment"),
  // Convenience: if true, also mint a case-access token for the provider
  // in the same flow so the response includes a magic-link URL. Matches
  // the behavior of POST /v1/cockpit/cases/:caseId/invite-provider — kept
  // as a separate call rather than a hard-coded side effect so staff can
  // create a case without immediately notifying the provider.
  sendInvite: z.boolean().default(false),
});

cockpitCaseRoutes.post("/v1/cockpit/cases", zValidator("json", CreateCaseBody), async (c) => {
  const auth = c.var.staffAuth;
  const workspaceId = c.var.tenancy.workspaceId;
  const body = c.req.valid("json");

  // Validate the provider is in this workspace before the insert — the
  // FK below only enforces existence, not workspace membership.
  const created = await withTenancy(c.var.tenancy, async (tx) => {
    const [grant] = await tx
      .select({ providerId: schema.providerWorkspaceGrants.providerId })
      .from(schema.providerWorkspaceGrants)
      .where(
        and(
          eq(schema.providerWorkspaceGrants.providerId, body.providerId),
          eq(schema.providerWorkspaceGrants.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!grant) return { kind: "provider_not_in_workspace" as const };

    // Facility must have an approved profile in this workspace; pin the
    // case to that profile's id + version.
    const approvedRows = await tx
      .select({
        profileId: schema.facilityProfiles.id,
        version: schema.facilityProfiles.version,
      })
      .from(schema.facilityProfiles)
      .where(
        and(
          eq(schema.facilityProfiles.facilityId, body.facilityId),
          eq(schema.facilityProfiles.workspaceId, workspaceId),
          eq(schema.facilityProfiles.status, "approved"),
        ),
      )
      .orderBy(desc(schema.facilityProfiles.version))
      .limit(1);
    const approved = approvedRows[0];
    if (!approved) return { kind: "no_approved_profile" as const };

    // Reject if an open case already exists for this (provider, facility).
    // We treat submitted / completed / withdrawn as "done" so a repeat
    // credentialing is allowed once the previous cycle is closed.
    const [existingOpen] = await tx
      .select({ id: schema.cases.id, status: schema.cases.status })
      .from(schema.cases)
      .where(
        and(
          eq(schema.cases.workspaceId, workspaceId),
          eq(schema.cases.providerId, body.providerId),
          eq(schema.cases.facilityProfileId, approved.profileId),
          sql`${schema.cases.status} NOT IN ('submitted','completed','withdrawn')`,
        ),
      )
      .limit(1);
    if (existingOpen) {
      return { kind: "case_already_open" as const, caseId: existingOpen.id };
    }

    const [row] = await tx
      .insert(schema.cases)
      .values({
        workspaceId,
        providerId: body.providerId,
        facilityProfileId: approved.profileId,
        facilityProfileVersion: String(approved.version),
        specialty: body.specialty,
        purpose: body.purpose,
        status: "intake",
        targetSubmissionDate: body.targetSubmissionDate ?? null,
        assignedSpecialistId: auth.session.userId,
      })
      .returning({ id: schema.cases.id });
    if (!row) throw new Error("case insert failed");
    return {
      kind: "ok" as const,
      caseId: row.id,
      facilityProfileId: approved.profileId,
      facilityProfileVersion: approved.version,
    };
  });

  if (created.kind === "provider_not_in_workspace") {
    return c.json(
      {
        type: "https://errors.cred/cases/provider-not-in-workspace",
        title: "Provider is not in this workspace",
        status: 422,
        instance: c.var.requestId,
      },
      422,
    );
  }
  if (created.kind === "no_approved_profile") {
    return c.json(
      {
        type: "https://errors.cred/cases/no-approved-facility-profile",
        title: "Facility has no approved profile in this workspace",
        status: 422,
        instance: c.var.requestId,
      },
      422,
    );
  }
  if (created.kind === "case_already_open") {
    return c.json(
      {
        type: "https://errors.cred/cases/already-open",
        title: "An open case already exists for this provider and facility",
        status: 409,
        instance: c.var.requestId,
        caseId: created.caseId,
      },
      409,
    );
  }

  await audit({
    workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "case.created",
    targetEntityType: "case",
    targetEntityId: created.caseId,
    after: {
      providerId: body.providerId,
      facilityId: body.facilityId,
      specialty: body.specialty,
      purpose: body.purpose,
      facilityProfileVersion: created.facilityProfileVersion,
    },
    requestId: c.var.requestId,
  });

  // Optional inline invite. Mint the case-access token and log the same
  // magic-link-shaped audit row the standalone invite endpoint emits so
  // the watcher script surfaces the URL uniformly.
  let inviteUrl: string | null = null;
  let inviteExpiresAt: string | null = null;
  if (body.sendInvite) {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { token } = await issueCaseAccessToken({
      caseId: created.caseId,
      providerId: body.providerId,
      workspaceId,
      expiresAt,
      issuedByUserId: auth.session.userId,
    });
    inviteUrl = new URL(`/invite/${token}`, env().WEB_PUBLIC_URL).toString();
    inviteExpiresAt = expiresAt.toISOString();

    // Look up email for the audit / watcher line.
    const [provider] = await withTenancy(c.var.tenancy, async (tx) =>
      tx
        .select({ email: schema.providers.email })
        .from(schema.providers)
        .where(eq(schema.providers.id, body.providerId))
        .limit(1),
    );

    await audit({
      workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "auth.provider_invite.magic_link.issued",
      targetEntityType: "case",
      targetEntityId: created.caseId,
      after: {
        providerId: body.providerId,
        email: provider?.email ?? null,
        url: inviteUrl,
        expiresAt: inviteExpiresAt,
      },
      requestId: c.var.requestId,
    });
    logger.info(
      {
        workspaceId,
        caseId: created.caseId,
        providerId: body.providerId,
        email: provider?.email ?? null,
        url: inviteUrl,
        expiresAt: inviteExpiresAt,
      },
      "auth.provider_invite.magic_link.issued",
    );
  }

  return c.json(
    {
      caseId: created.caseId,
      facilityProfileId: created.facilityProfileId,
      facilityProfileVersion: created.facilityProfileVersion,
      invite: inviteUrl ? { url: inviteUrl, expiresAt: inviteExpiresAt } : null,
    },
    201,
  );
});
