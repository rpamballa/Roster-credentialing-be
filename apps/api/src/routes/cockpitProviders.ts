import { randomUUID } from "node:crypto";
import { ProviderInviteInvalidError, issueProviderInviteToken, sendEmail } from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { DocumentType } from "@cred/types/domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import heicConvert from "heic-convert";
import { type Context, Hono } from "hono";
import sharp from "sharp";
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
      // The adapter returns PUT for real GCS (v4-signed XML URL) and
      // POST for the fake-gcs-server emulator's upload endpoint.
      // Clients must use the method the adapter picked — hardcoding
      // PUT breaks the emulator path.
      method: signed.method,
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
          text: `Hi ${firstName},\n\nYou've been invited to join the Roster Healthcare credentialing platform. Accept your invite here:\n\n${url}\n\nThis link expires in 7 days. Once your invite is accepted we'll notify you by email as soon as your first credentialing case is ready.\n\n— The Roster Healthcare team`,
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
      text: `Hi ${firstName},\n\nHere's a fresh link to accept your Roster Healthcare invite. The previous link has been retired.\n\n${url}\n\nThis link expires in 7 days.\n\n— The Roster Healthcare team`,
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

// ─── GET /v1/cockpit/providers/:providerId/documents/:docId/source ───────
// Serve a doc-viewer descriptor for a provider-scoped document. Returns
// the signed GCS read URL, the MIME type, and (best-effort) page count so
// the FE viewer knows whether to render as PDF, image, or Word HTML.
//
// Auth: workspace grant on the provider (same as sign-upload/finalize).
// The FE BFF proxies the byte stream through same-origin so signed GCS
// URLs never reach the browser directly — mirrors the case-scoped source
// pattern used by /v1/cases/:caseId/documents/:docId.
cockpitProviderRoutes.get(
  "/v1/cockpit/providers/:providerId/documents/:docId/source",
  async (c) => {
    const workspaceId = c.var.tenancy.workspaceId;
    const providerId = c.req.param("providerId");
    const docId = c.req.param("docId");

    const granted = await ensureGrantedProvider(workspaceId, providerId);
    if (!granted) return notFoundResponse(c);

    // rls: bypass — documents are provider-scoped, workspace-gated above.
    const [doc] = await db()
      .select({
        id: schema.documents.id,
        fileUri: schema.documents.fileUri,
        mimeType: schema.documents.mimeType,
        pageCount: schema.documents.pageCount,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, docId), eq(schema.documents.providerId, providerId)))
      .limit(1);
    if (!doc || !doc.fileUri) return notFoundResponse(c);

    // Short-TTL signed READ URL. The FE BFF fetches it server-side once
    // and streams the bytes back same-origin, so it never leaks to the
    // browser.
    const signed = await getObjectStorage().getSignedUrl({
      key: doc.fileUri,
      expiresInSeconds: 60,
    });

    return c.json({
      sourceUrl: signed.url,
      mimeType: doc.mimeType ?? "application/pdf",
      pageCount: doc.pageCount ?? 1,
    });
  },
);

// ─── GET /v1/cockpit/documents/:docId/bytes ──────────────────────────────
// Stream a document's raw bytes back to the FE, transcoded to a browser-
// safe format when necessary. This is what the FE source proxies (both
// provider- and case-scoped) fetch from — they no longer touch the signed
// GCS URL directly, so the transcoding happens uniformly regardless of
// which surface (provider profile, case detail) opens the doc.
//
// Why transcode server-side: iPhone camera uploads default to HEIC/HEIF,
// which Chrome and Firefox have no native <img> decoder for. Instead of
// shipping a WASM decoder to every browser (fragile across HEIC variants;
// heic2any silently fails on HEIF-with-HEVC subtypes we saw in the beta),
// we decode once here with sharp (libvips + libheif) and stream JPEG. TIFF
// and BMP get the same treatment. JPEG/PNG/WebP/GIF/AVIF pass through
// unchanged (browsers render them natively). PDF passes through too.
//
// Auth: docId-only, but we resolve the doc's providerId and verify the
// workspace has a grant on it. Both the provider profile viewer and the
// case detail viewer need this; scoping by provider is stricter than by
// case (a workspace with only case-level access to a shared doc wouldn't
// be a real scenario in this data model — cases are provider-scoped).
cockpitProviderRoutes.get("/v1/cockpit/documents/:docId/bytes", async (c) => {
  const workspaceId = c.var.tenancy.workspaceId;
  const docId = c.req.param("docId");

  // rls: bypass — the workspace grant check below is the access control.
  const [doc] = await db()
    .select({
      id: schema.documents.id,
      providerId: schema.documents.providerId,
      fileUri: schema.documents.fileUri,
      mimeType: schema.documents.mimeType,
    })
    .from(schema.documents)
    .where(eq(schema.documents.id, docId))
    .limit(1);
  if (!doc || !doc.fileUri) return notFoundResponse(c);

  const granted = await ensureGrantedProvider(workspaceId, doc.providerId);
  if (!granted) return notFoundResponse(c);

  // Fetch the raw bytes via a short-lived signed READ URL. Same path the
  // signed-URL flow used, but we consume it here and stream the result.
  const signed = await getObjectStorage().getSignedUrl({
    key: doc.fileUri,
    expiresInSeconds: 30,
  });
  const upstream = await fetch(signed.url);
  if (!upstream.ok || !upstream.body) {
    logger.error({ docId, status: upstream.status }, "document_bytes_storage_fetch_failed");
    return c.json({ title: "Storage fetch failed", status: upstream.status }, 502);
  }

  const declaredMime = doc.mimeType ?? "application/octet-stream";
  const stream = await streamDocumentBytes({
    upstream,
    declaredMime,
    docId,
  });
  return new Response(stream.body, {
    status: 200,
    headers: {
      "content-type": stream.contentType,
      // Signed URL is 30s TTL; a browser cache of 60s keeps repeat views
      // (page nav, zoom) snappy without holding stale bytes.
      "cache-control": "private, max-age=60",
    },
  });
});

// Formats every mainstream browser can render inline in <img> without
// intervention. AVIF is in every major browser as of 2024; keeping it
// here means we DON'T transcode AVIF uploads (which would be lossy).
const BROWSER_SAFE_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
]);

// HEIC / HEIF variants. sharp's prebuilt libvips ships without a
// HEVC decoder plugin (patent avoidance), so these route through the
// heic-convert path instead — that library bundles libde265 and
// decodes HEVC natively.
const HEIC_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

// Non-safe formats sharp CAN decode with its stock prebuild: TIFF and
// BMP. AVIF is handled as browser-safe (it's an ISO-BMFF cousin of
// HEIF but every current browser renders AVIF inline; only HEIC is
// the odd one out).
const SHARP_DECODABLE_MIMES = new Set(["image/tiff", "image/tif", "image/bmp", "image/x-bmp"]);

async function streamDocumentBytes(args: {
  upstream: Response;
  declaredMime: string;
  docId: string;
}): Promise<{ body: BodyInit; contentType: string }> {
  const { upstream, declaredMime, docId } = args;

  // PDFs — always stream through untouched. react-pdf handles them.
  if (declaredMime === "application/pdf") {
    return { body: upstream.body as ReadableStream, contentType: "application/pdf" };
  }

  // Browser-safe images — pass through.
  if (BROWSER_SAFE_IMAGE_MIMES.has(declaredMime)) {
    return { body: upstream.body as ReadableStream, contentType: declaredMime };
  }

  // Buffer + inspect magic bytes for anything else. Trust the stored
  // mime as a first hint but never as the last word — providers upload
  // renamed files all the time, and a JPEG with a `.heic` extension
  // (or vice-versa) mustn't blow up here.
  const inputBuf = Buffer.from(await upstream.arrayBuffer());
  const sniffed = sniffImageMime(inputBuf) ?? declaredMime;

  if (BROWSER_SAFE_IMAGE_MIMES.has(sniffed)) {
    return { body: inputBuf, contentType: sniffed };
  }

  // HEIC/HEIF — decode via heic-convert (bundled libde265), then run
  // through sharp for mozjpeg re-encoding at the same quality budget
  // as everything else so file sizes stay reasonable.
  if (HEIC_MIMES.has(sniffed)) {
    try {
      const rawJpeg = await heicConvert({ buffer: inputBuf, format: "JPEG", quality: 0.85 });
      const optimized = await sharp(Buffer.from(rawJpeg))
        .rotate()
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      return { body: optimized, contentType: "image/jpeg" };
    } catch (err) {
      logger.warn({ err, docId, declaredMime, sniffed }, "document_bytes_heic_transcode_failed");
      // Fall through to raw stream so the browser at least offers a
      // download instead of a 500.
    }
  }

  // TIFF / BMP / anything else image-shaped — try sharp. Its stock
  // build handles these fine.
  if (SHARP_DECODABLE_MIMES.has(sniffed) || sniffed.startsWith("image/")) {
    try {
      const jpegBuf = await sharp(inputBuf, { failOn: "none" })
        .rotate() // respect EXIF orientation
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      return { body: jpegBuf, contentType: "image/jpeg" };
    } catch (err) {
      logger.warn({ err, docId, declaredMime, sniffed }, "document_bytes_transcode_failed");
      // Fall through to raw stream below so the browser at least offers
      // a download instead of a 500.
    }
  }

  // Non-image, non-PDF, or unsupported — stream original bytes with the
  // declared mime and let the browser handle it (usually a download).
  return { body: inputBuf, contentType: declaredMime };
}

/**
 * Read the first ~12 bytes of a buffer to identify its actual image
 * format. This runs on every non-safe upload, so keep it allocation-free
 * and short-circuit as soon as a signature matches.
 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  // WebP: RIFF ... WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp";
  // BMP: BM
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  // TIFF: II*\0 or MM\0*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  )
    return "image/tiff";
  // ISO-BMFF (HEIC/HEIF/AVIF): bytes 4-11 are "ftyp" then a brand code.
  // heic/heix/mif1/msf1 = HEIC. avif = AVIF. We only need to distinguish
  // heic-shaped vs avif here; both flow to the sharp branch anyway.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    return "image/heic";
  }
  return null;
}

// ─── DELETE /v1/cockpit/providers/:providerId/documents/:docId ───────────
// Admin cleanup of a provider document (stale ingest, wrong upload, duplicate).
// Removes both the DB row AND the GCS object so we never leave orphaned
// bytes in the bucket. Refuses if a submitted packet references this doc —
// admin must roll back the packet first.
//
// Provider-side (magic-link) sessions cannot reach this route; the
// cockpit auth middleware requires a staff writer.
cockpitProviderRoutes.delete("/v1/cockpit/providers/:providerId/documents/:docId", async (c) => {
  const auth = c.var.staffAuth;
  const workspaceId = c.var.tenancy.workspaceId;
  const providerId = c.req.param("providerId");
  const docId = c.req.param("docId");

  const granted = await ensureGrantedProvider(workspaceId, providerId);
  if (!granted) return notFoundResponse(c);

  // rls: bypass — documents are provider-scoped, workspace-gated above.
  const [doc] = await db()
    .select({ id: schema.documents.id, fileUri: schema.documents.fileUri })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, docId), eq(schema.documents.providerId, providerId)))
    .limit(1);
  if (!doc) return notFoundResponse(c);

  // Guard: submitted packets reference document ids in
  // provenance.documentIds. If any submitted packet in the workspace
  // includes this doc, refuse — deleting would break the compliance
  // trail. Draft/unsubmitted packets are fine (they get rebuilt from
  // fresh docs anyway).
  const [pinnedByPacket] = await db()
    .select({ id: schema.packets.id })
    .from(schema.packets)
    .where(
      and(
        eq(schema.packets.workspaceId, workspaceId),
        sql`${schema.packets.submittedAt} IS NOT NULL`,
        sql`${schema.packets.provenance}->'documentIds' @> ${JSON.stringify([docId])}::jsonb`,
      ),
    )
    .limit(1);
  if (pinnedByPacket) {
    return c.json(
      {
        type: "https://errors.cred/documents/pinned-by-packet",
        title: "Document is referenced by a submitted packet",
        status: 409,
        instance: c.var.requestId,
        packetId: pinnedByPacket.id,
      },
      409,
    );
  }

  // Best-effort delete of the GCS object. If the object isn't there
  // (never landed), the adapter's ignoreNotFound: true swallows it.
  // The DB row is the source of truth; if the storage call throws
  // for a real reason we abort so we don't leave the DB pointing at
  // a stale key.
  if (doc.fileUri) {
    try {
      await getObjectStorage().delete(doc.fileUri);
    } catch (err) {
      logger.error({ err, docId, fileUri: doc.fileUri }, "document_delete_storage_failed");
      return c.json(
        {
          type: "https://errors.cred/documents/storage-delete-failed",
          title: "Failed to delete the underlying file",
          status: 502,
          instance: c.var.requestId,
        },
        502,
      );
    }
  }

  await db().delete(schema.documents).where(eq(schema.documents.id, docId));

  await audit({
    workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "document.deleted",
    targetEntityType: "document",
    targetEntityId: docId,
    before: { providerId, fileUri: doc.fileUri },
    requestId: c.var.requestId,
  });

  return new Response(null, { status: 204 });
});

// Silence "declared but never read" — `ProviderInviteInvalidError` is
// re-exported here for the redemption endpoint to catch typed.
export { ProviderInviteInvalidError };
