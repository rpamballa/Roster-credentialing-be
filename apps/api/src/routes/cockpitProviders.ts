import { randomUUID } from "node:crypto";
import { ProviderInviteInvalidError, issueProviderInviteToken, sendEmail } from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { DocumentType } from "@cred/types/domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { fromFeDocumentType } from "../graphql/mappings.js";
import { requireWriterOnMutations } from "../middleware/rbac.js";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import type { ApiBindings } from "../types.js";

export const cockpitProviderRoutes = new Hono<ApiBindings>();

cockpitProviderRoutes.use(
  "/v1/cockpit/*",
  requireStaffAuth,
  requireTenancy,
  requireWriterOnMutations,
);

const MAX_DOC_BYTES = 50 * 1024 * 1024;

const FE_DOCUMENT_TYPES = [
  "medical_license",
  "dea",
  "board_certification",
  "bls",
  "acls",
  "medical_diploma",
  "government_id",
  "vaccination",
  "malpractice_insurance",
] as const;

const SignUploadBody = z.object({
  documentType: z.enum(FE_DOCUMENT_TYPES),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_DOC_BYTES),
});

async function ensureGrantedProvider(workspaceId: string, providerId: string): Promise<boolean> {
  // rls: bypass — provider_workspace_grants is the workspace-access table
  // itself; checking it IS the access check.
  const [row] = await db()
    .select({ providerId: schema.providerWorkspaceGrants.providerId })
    .from(schema.providerWorkspaceGrants)
    .where(
      and(
        eq(schema.providerWorkspaceGrants.providerId, providerId),
        eq(schema.providerWorkspaceGrants.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

cockpitProviderRoutes.post(
  "/v1/cockpit/providers/:providerId/documents/sign-upload",
  zValidator("json", SignUploadBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const providerId = c.req.param("providerId");
    const body = c.req.valid("json");

    const granted = await ensureGrantedProvider(c.var.tenancy.workspaceId, providerId);
    if (!granted) return notFoundResponse(c);

    const documentId = randomUUID();
    const key = `documents/${providerId}/${documentId}`;
    const signed = await getObjectStorage().putSignedUrl({
      key,
      contentType: body.mimeType,
      expiresInSeconds: 15 * 60,
    });

    const docType: DocumentType = fromFeDocumentType(body.documentType);
    // rls: bypass — documents are global to a provider, not workspace-scoped.
    // The workspace gate above ensures the actor can act on this provider.
    await db().insert(schema.documents).values({
      id: documentId,
      providerId,
      documentType: docType,
      fileUri: key,
      mimeType: body.mimeType,
      source: "specialist_upload",
      extractionStatus: "pending",
      uploadedBy: auth.session.userId,
    });

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "document.upload_signed",
      targetEntityType: "document",
      targetEntityId: documentId,
      after: { providerId, documentType: docType, sizeBytes: body.sizeBytes },
      requestId: c.var.requestId,
    });

    return c.json({
      documentId,
      uploadUrl: signed.url,
      headers: signed.headers,
      maxBytes: MAX_DOC_BYTES,
    });
  },
);

cockpitProviderRoutes.post(
  "/v1/cockpit/providers/:providerId/documents/:docId/uploaded",
  async (c) => {
    const auth = c.var.staffAuth;
    const providerId = c.req.param("providerId");
    const docId = c.req.param("docId");

    const granted = await ensureGrantedProvider(c.var.tenancy.workspaceId, providerId);
    if (!granted) return notFoundResponse(c);

    // rls: bypass — documents are provider-scoped, workspace-gated above.
    const [doc] = await db()
      .select({ id: schema.documents.id, fileUri: schema.documents.fileUri })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, docId), eq(schema.documents.providerId, providerId)))
      .limit(1);
    if (!doc) return notFoundResponse(c);

    const exists = await getObjectStorage().exists(doc.fileUri);
    if (!exists) {
      logger.warn({ docId }, "specialist_upload_missing_object");
      return c.json(
        {
          type: "https://errors.cred/upload/missing",
          title: "Upload not found in object storage",
          status: 409,
          instance: c.var.requestId,
        },
        409,
      );
    }

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "document.uploaded",
      targetEntityType: "document",
      targetEntityId: docId,
      after: { providerId, source: "specialist_upload" },
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

// ─── POST /v1/cockpit/providers/invite ────────────────────────────────────
// Beta onboarding: bulk-invite providers by email to the current workspace.
// One provider_invite_tokens row + one Resend email per input entry. Sends
// in-line rather than via Temporal — this is a low-volume operator action
// and the specialist wants a per-row success/failure signal in the modal.
//
// Idempotency: an invite for the same (workspace, email) that's still open
// (not redeemed, not revoked, not expired) is returned as `already_invited`
// with the existing URL — no new token minted. Once redeemed, a new invite
// re-issues cleanly.

const InviteRow = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  fullName: z.string().trim().max(200).optional(),
});
const InviteBody = z.object({
  invites: z.array(InviteRow).min(1).max(20),
});

type InviteResult =
  | { email: string; status: "sent"; url: string; expiresAt: string }
  | { email: string; status: "already_invited"; expiresAt: string }
  | { email: string; status: "failed"; error: string };

cockpitProviderRoutes.post(
  "/v1/cockpit/providers/invite",
  zValidator("json", InviteBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const workspaceId = c.var.tenancy.workspaceId;
    const { invites } = c.req.valid("json");
    const cfg = env();

    const results: InviteResult[] = [];
    for (const row of invites) {
      try {
        // Dedupe on an OPEN invite for the same (workspace, email). A
        // redeemed or expired token doesn't block a fresh one.
        // rls: bypass — the invite table is filtered by workspace_id;
        // no cross-workspace read is possible with this predicate.
        const openInvite = await findOpenInvite(workspaceId, row.email);
        if (openInvite) {
          results.push({
            email: row.email,
            status: "already_invited",
            expiresAt: openInvite.expiresAt.toISOString(),
          });
          continue;
        }

        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const { token } = await issueProviderInviteToken({
          workspaceId,
          email: row.email,
          fullName: row.fullName ?? null,
          invitedByUserId: auth.session.userId,
          expiresAt,
        });
        const url = new URL(`/invite/${token}`, cfg.WEB_PUBLIC_URL).toString();

        // Watcher-shaped log so scripts/magic-link-watch.sh sees it too.
        logger.info(
          {
            action: "auth.provider_invite.magic_link.issued",
            workspaceId,
            email: row.email,
            url,
          },
          "provider_workspace_invite_magic_link_issued",
        );

        const firstName = row.fullName?.trim().split(/\s+/)[0] || "there";
        await sendEmail({
          to: row.email,
          subject: "You've been invited to Roster Healthcare",
          text:
            `Hi ${firstName},\n\n` +
            "You've been invited to join the Roster Healthcare credentialing platform. " +
            "Accept your invite here:\n\n" +
            `${url}\n\n` +
            "This link expires in 7 days. Once your invite is accepted we'll " +
            "notify you by email as soon as your first credentialing case is ready.\n\n" +
            "— The Roster Healthcare team",
        });

        await audit({
          workspaceId,
          actorUserId: auth.session.userId,
          actorType: "user",
          action: "provider_invite.sent",
          targetEntityType: "workspace",
          targetEntityId: workspaceId,
          after: { email: row.email, url, expiresAt: expiresAt.toISOString() },
          requestId: c.var.requestId,
        });

        results.push({
          email: row.email,
          status: "sent",
          url,
          expiresAt: expiresAt.toISOString(),
        });
      } catch (err) {
        logger.error({ err, email: row.email, workspaceId }, "provider_workspace_invite_failed");
        results.push({
          email: row.email,
          status: "failed",
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }

    return c.json({ results });
  },
);

async function findOpenInvite(workspaceId: string, email: string) {
  const now = new Date();
  const rows = await db()
    .select({
      id: schema.providerInviteTokens.id,
      expiresAt: schema.providerInviteTokens.expiresAt,
      redeemedAt: schema.providerInviteTokens.redeemedAt,
      revokedAt: schema.providerInviteTokens.revokedAt,
    })
    .from(schema.providerInviteTokens)
    .where(
      and(
        eq(schema.providerInviteTokens.workspaceId, workspaceId),
        eq(schema.providerInviteTokens.email, email),
      ),
    );
  return rows.find((r) => !r.redeemedAt && !r.revokedAt && r.expiresAt.getTime() > now.getTime());
}

// ─── GET /v1/cockpit/providers/invites ────────────────────────────────────
// List the workspace's provider invites, newest first. The derived `status`
// column lets the cockpit render pending / accepted / expired / revoked
// without every caller re-implementing the same time comparison.
//
// Not paginated — the cap of 100 rows is plenty for the beta window; add
// a proper cursor once real workspaces need it.
cockpitProviderRoutes.get("/v1/cockpit/providers/invites", async (c) => {
  const workspaceId = c.var.tenancy.workspaceId;

  // rls: bypass — filtered by workspace_id; no cross-workspace read possible.
  const rows = await db()
    .select({
      id: schema.providerInviteTokens.id,
      email: schema.providerInviteTokens.email,
      fullName: schema.providerInviteTokens.fullName,
      invitedByUserId: schema.providerInviteTokens.invitedByUserId,
      createdAt: schema.providerInviteTokens.createdAt,
      expiresAt: schema.providerInviteTokens.expiresAt,
      redeemedAt: schema.providerInviteTokens.redeemedAt,
      revokedAt: schema.providerInviteTokens.revokedAt,
      providerId: schema.providerInviteTokens.providerId,
    })
    .from(schema.providerInviteTokens)
    .where(eq(schema.providerInviteTokens.workspaceId, workspaceId))
    .orderBy(desc(schema.providerInviteTokens.createdAt))
    .limit(100);

  const now = Date.now();
  const invites = rows.map((r) => {
    let status: "pending" | "accepted" | "expired" | "revoked";
    if (r.redeemedAt) status = "accepted";
    else if (r.revokedAt) status = "revoked";
    else if (r.expiresAt.getTime() < now) status = "expired";
    else status = "pending";
    return {
      id: r.id,
      email: r.email,
      fullName: r.fullName,
      status,
      invitedAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      redeemedAt: r.redeemedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      providerId: r.providerId,
    };
  });

  return c.json({ invites });
});

// ─── POST /v1/cockpit/providers/invites/:inviteId/resend ─────────────────
// Revoke the old token and mint a fresh one (7-day window) for the same
// email + fullName, then re-send the Resend email. Accepted invites can
// still be re-issued — sometimes the tester lost their inbox after
// accepting and needs the case-scoped link path, but until we ship that,
// re-issuing the workspace invite is the cleanest recovery.
cockpitProviderRoutes.post("/v1/cockpit/providers/invites/:inviteId/resend", async (c) => {
  const auth = c.var.staffAuth;
  const workspaceId = c.var.tenancy.workspaceId;
  const inviteId = c.req.param("inviteId");
  const cfg = env();

  // rls: bypass — scoped to workspaceId in the WHERE.
  const [existing] = await db()
    .select({
      email: schema.providerInviteTokens.email,
      fullName: schema.providerInviteTokens.fullName,
    })
    .from(schema.providerInviteTokens)
    .where(
      and(
        eq(schema.providerInviteTokens.id, inviteId),
        eq(schema.providerInviteTokens.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!existing) return notFoundResponse(c);

  // Revoke the old — protects against a stale link redeeming after
  // we've handed the tester a fresh one.
  await db()
    .update(schema.providerInviteTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.providerInviteTokens.id, inviteId),
        eq(schema.providerInviteTokens.workspaceId, workspaceId),
      ),
    );

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const { token } = await issueProviderInviteToken({
    workspaceId,
    email: existing.email,
    fullName: existing.fullName,
    invitedByUserId: auth.session.userId,
    expiresAt,
  });
  const url = new URL(`/invite/${token}`, cfg.WEB_PUBLIC_URL).toString();

  logger.info(
    {
      action: "auth.provider_invite.magic_link.issued",
      workspaceId,
      email: existing.email,
      url,
    },
    "provider_workspace_invite_magic_link_resent",
  );

  const firstName = existing.fullName?.trim().split(/\s+/)[0] || "there";
  try {
    await sendEmail({
      to: existing.email,
      subject: "Your Roster Healthcare invite (fresh link)",
      text:
        `Hi ${firstName},\n\n` +
        "Here's a fresh link to accept your Roster Healthcare invite. " +
        "The previous link has been retired.\n\n" +
        `${url}\n\n` +
        "This link expires in 7 days.\n\n" +
        "— The Roster Healthcare team",
    });
  } catch (err) {
    logger.error(
      { err, email: existing.email, workspaceId },
      "provider_workspace_invite_resend_email_failed",
    );
  }

  await audit({
    workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "provider_invite.resent",
    targetEntityType: "workspace",
    targetEntityId: workspaceId,
    after: { email: existing.email, url, expiresAt: expiresAt.toISOString() },
    requestId: c.var.requestId,
  });

  return c.json({ url, expiresAt: expiresAt.toISOString() });
});

// ─── POST /v1/cockpit/providers/invites/:inviteId/revoke ─────────────────
// Kill a pending invite. Idempotent — revoking an already-revoked or
// already-redeemed invite is a no-op (returns the current state).
cockpitProviderRoutes.post("/v1/cockpit/providers/invites/:inviteId/revoke", async (c) => {
  const auth = c.var.staffAuth;
  const workspaceId = c.var.tenancy.workspaceId;
  const inviteId = c.req.param("inviteId");

  // rls: bypass — scoped to workspaceId in the WHERE.
  const [row] = await db()
    .update(schema.providerInviteTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.providerInviteTokens.id, inviteId),
        eq(schema.providerInviteTokens.workspaceId, workspaceId),
        isNull(schema.providerInviteTokens.revokedAt),
        isNull(schema.providerInviteTokens.redeemedAt),
      ),
    )
    .returning({
      id: schema.providerInviteTokens.id,
      revokedAt: schema.providerInviteTokens.revokedAt,
      email: schema.providerInviteTokens.email,
    });

  if (row) {
    await audit({
      workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "provider_invite.revoked",
      targetEntityType: "workspace",
      targetEntityId: workspaceId,
      after: { inviteId, email: row.email },
      requestId: c.var.requestId,
    });
  }

  return c.json({ ok: true });
});

// ─── GET /v1/cockpit/providers ────────────────────────────────────────────
// Workspace's provider roster — everyone with an active
// provider_workspace_grants row for this workspace. Includes an
// activeCases count derived from the cases table so the roster UI can
// show "0 active" vs "3 active" without a per-row round trip.
//
// Not paginated (100-row cap) — plenty for the beta. Add a cursor when
// a real agency ships >100 providers.
cockpitProviderRoutes.get("/v1/cockpit/providers", async (c) => {
  const workspaceId = c.var.tenancy.workspaceId;

  // rls: bypass — provider_workspace_grants IS the workspace-access
  // check. Filtering by workspace_id here is the authorization.
  const rows = await db()
    .select({
      id: schema.providers.id,
      firstName: schema.providers.firstName,
      lastName: schema.providers.lastName,
      email: schema.providers.email,
      npi: schema.providers.npi,
      specialties: schema.providers.specialties,
      grantedAt: schema.providerWorkspaceGrants.grantedAt,
    })
    .from(schema.providerWorkspaceGrants)
    .innerJoin(schema.providers, eq(schema.providers.id, schema.providerWorkspaceGrants.providerId))
    .where(eq(schema.providerWorkspaceGrants.workspaceId, workspaceId))
    .orderBy(desc(schema.providerWorkspaceGrants.grantedAt))
    .limit(100);

  // Active-cases per provider — one query, group by provider_id.
  // "Active" = anything not in a terminal state (completed/withdrawn).
  const TERMINAL_CASE_STATUSES = new Set(["completed", "withdrawn"] as const);
  const providerIds = rows.map((r) => r.id);
  const activeCaseCounts = new Map<string, number>();
  if (providerIds.length > 0) {
    // rls: bypass — cases.workspace_id is enforced by the same
    // workspaceId we're already scoping the roster with.
    const caseRows = await db()
      .select({
        providerId: schema.cases.providerId,
        status: schema.cases.status,
      })
      .from(schema.cases)
      .where(eq(schema.cases.workspaceId, workspaceId));
    for (const cr of caseRows) {
      if (!providerIds.includes(cr.providerId)) continue;
      if ((TERMINAL_CASE_STATUSES as Set<string>).has(cr.status)) continue;
      activeCaseCounts.set(cr.providerId, (activeCaseCounts.get(cr.providerId) ?? 0) + 1);
    }
  }

  const providers = rows.map((r) => ({
    id: r.id,
    fullName: `${r.firstName} ${r.lastName}`.trim() || r.email || "Provider",
    email: r.email,
    npi: r.npi,
    specialties: r.specialties,
    grantedAt: r.grantedAt.toISOString(),
    activeCases: activeCaseCounts.get(r.id) ?? 0,
  }));

  return c.json({ providers });
});

// Silence "declared but never read" — `ProviderInviteInvalidError` is
// re-exported here for the redemption endpoint to catch typed.
export { ProviderInviteInvalidError };
