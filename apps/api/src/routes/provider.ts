import { createHash } from "node:crypto";
import {
  CaseAccessInvalidError,
  ProviderInviteInvalidError,
  attachProviderToInvite,
  createProviderSession,
  ensureProviderAccount,
  hashProviderInviteToken,
  previewProviderInviteToken,
  redeemCaseAccessToken,
  redeemProviderInviteToken,
} from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

export const providerRoutes = new Hono<ApiBindings>();

// ─── auth: redeem a case access token, mint a provider session ───────────
const RedeemSchema = z.object({ token: z.string().min(32).max(256) });
providerRoutes.post("/provider/auth/redeem", zValidator("json", RedeemSchema), async (c) => {
  try {
    const { caseId, providerId, workspaceId } = await redeemCaseAccessToken(
      c.req.valid("json").token,
    );
    const sid = await createProviderSession({
      providerId,
      caseId,
      caseWorkspaceId: workspaceId,
    });
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: env().NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    await audit({
      workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "auth.provider_invite.redeemed",
      targetEntityType: "case",
      targetEntityId: caseId,
      after: { providerId },
      requestId: c.var.requestId,
    });
    return c.json({ ok: true, caseId, providerId });
  } catch (err) {
    if (err instanceof CaseAccessInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/provider/invalid-token",
          title: "Invalid or expired case access token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }
});

// ─── auth: preview — peek at the token without consuming it ──────────────
// Handles both invite kinds:
//   - "case"      → case_access_tokens (existing per-case invite flow)
//   - "workspace" → provider_invite_tokens (beta pre-case invite; no case
//                    exists yet, so we can only greet by workspace + name)
// The FE renders different landing copy based on `kind` in the response.
// The token is NOT consumed here; redemption happens on redeem / redeem-invite.
const PreviewSchema = z.object({ token: z.string().min(32).max(256) });
providerRoutes.post("/provider/auth/preview", zValidator("json", PreviewSchema), async (c) => {
  const { token } = c.req.valid("json");

  // Try the workspace-invite table first — cheaper single-table lookup.
  try {
    const preview = await previewProviderInviteToken(token);
    const first = preview.fullName?.trim().split(/\s+/)[0] ?? null;
    return c.json({
      kind: "workspace",
      workspaceName: preview.workspaceName,
      providerFirstName: first,
      email: preview.email,
    });
  } catch (err) {
    if (!(err instanceof ProviderInviteInvalidError)) throw err;
    // Fall through to the case-token lookup.
  }

  const hash = createHash("sha256").update(token).digest("hex");

  // rls: bypass — pre-session lookup by token hash + case/provider/workspace
  // joins. The whole point of this endpoint is to operate without a session.
  const [row] = await db()
    .select({
      caseId: schema.caseAccessTokens.caseId,
      providerId: schema.caseAccessTokens.providerId,
      facilityProfileId: schema.cases.facilityProfileId,
      workspaceId: schema.cases.workspaceId,
      targetSubmissionDate: schema.cases.targetSubmissionDate,
      firstName: schema.providers.firstName,
      lastName: schema.providers.lastName,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.caseAccessTokens)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.caseAccessTokens.caseId))
    .innerJoin(schema.providers, eq(schema.providers.id, schema.cases.providerId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.cases.workspaceId))
    .where(
      and(
        eq(schema.caseAccessTokens.tokenHash, hash),
        isNull(schema.caseAccessTokens.revokedAt),
        sql`${schema.caseAccessTokens.expiresAt} > now()`,
      ),
    )
    .limit(1);

  if (!row) {
    return c.json(
      {
        type: "https://errors.cred/provider/invalid-token",
        title: "Invalid or expired case access token",
        status: 400,
        instance: c.var.requestId,
      },
      400,
    );
  }

  // Look up the facility name. The cases table stores facility_profile_id
  // without a FK (M2 sequencing), so we resolve the profile → facility join
  // in a second query rather than threading it through the join above.
  let facilityName = "your facility";
  if (row.facilityProfileId) {
    const [fp] = await db()
      .select({ facilityId: schema.facilityProfiles.facilityId })
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.id, row.facilityProfileId))
      .limit(1);
    if (fp) {
      const [f] = await db()
        .select({ name: schema.facilities.name })
        .from(schema.facilities)
        .where(eq(schema.facilities.id, fp.facilityId))
        .limit(1);
      if (f?.name) facilityName = f.name;
    }
  }

  return c.json({
    kind: "case",
    providerFirstName: row.firstName,
    providerLastName: row.lastName,
    workspaceName: row.workspaceName,
    facilityName,
    totalSteps: 8,
    stepHighlights: [
      "Capture your license, DEA, and board certification",
      "Confirm AI-extracted fields with a tap",
      "Add two professional references",
      "E-sign your attestation",
    ],
    targetDate: row.targetSubmissionDate ?? null,
  });
});

// ─── POST /provider/auth/redeem-invite ────────────────────────────────────
// Workspace-scope invite redemption. Consumes a provider_invite_tokens row,
// upserts the providers row (keyed on lower(email); one provider may span
// multiple workspaces per PROMPT §4.1), and writes a provider_workspace_grants
// row so the cockpit sees them in /cockpit/providers. Does NOT mint a session:
// the per-case invite email — sent later when the workspace opens a case for
// this provider — is what logs them in.
providerRoutes.post(
  "/provider/auth/redeem-invite",
  zValidator("json", PreviewSchema),
  async (c) => {
    const { token } = c.req.valid("json");
    try {
      const invite = await redeemProviderInviteToken(token);

      // Single funnel for account creation: users row + providers row
      // linked via user_id + provider_workspace_grants — see
      // packages/auth/src/provider-account.ts. Idempotent, so a
      // re-redeem after the atomic-creation refactor is a no-op.
      const { providerId } = await ensureProviderAccount({
        email: invite.email,
        fullName: invite.fullName,
        workspaceId: invite.workspaceId,
      });

      await attachProviderToInvite(hashProviderInviteToken(token), providerId);

      await audit({
        workspaceId: invite.workspaceId,
        actorUserId: null,
        actorType: "system",
        action: "provider_invite.redeemed",
        targetEntityType: "provider",
        targetEntityId: providerId,
        after: { email: invite.email },
        requestId: c.var.requestId,
      });

      return c.json({
        ok: true,
        providerId,
        workspaceId: invite.workspaceId,
        email: invite.email,
      });
    } catch (err) {
      if (err instanceof ProviderInviteInvalidError) {
        return c.json(
          {
            type: "https://errors.cred/provider/invalid-invite",
            title: "Invalid or expired invite",
            status: 400,
            instance: c.var.requestId,
          },
          400,
        );
      }
      throw err;
    }
  },
);

// NOTE: the legacy `/provider/uploads/*`, `/provider/case/*`, and
// `/provider/documents/*` routes were removed once every FE BFF that
// referenced them migrated to the case-scoped `/v1/cases/:caseId/...`
// endpoints in cases.ts. Their auth guard couldn't resolve staff
// sessions (see PR #41 / #42) and their handlers duplicated logic that
// the case-scoped versions already own.
