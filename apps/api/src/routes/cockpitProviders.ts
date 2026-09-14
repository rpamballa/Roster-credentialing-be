import { randomUUID } from "node:crypto";
import { ProviderInviteInvalidError, issueProviderInviteToken, sendEmail } from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { DocumentType } from "@cred/types/domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
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

// Silence "declared but never read" — `ProviderInviteInvalidError` is
// re-exported here for the redemption endpoint to catch typed.
export { ProviderInviteInvalidError };
