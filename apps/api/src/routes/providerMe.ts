import { issueCaseAccessToken } from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireStaffAuth } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

/**
 * /v1/provider/me/* — endpoints for a password-authenticated provider
 * (i.e. staff-shape session where users.id → providers.user_id) to
 * discover and open their own cases.
 *
 * These are the counterpart of the case-scope magic-link surface
 * (/provider/case/*), which is gated by requireProviderAuth. The
 * password-session provider can't hit those routes directly, so we
 * expose a small bridge here: list their cases, and mint a case-scope
 * token on demand that lets them enter the case surface through the
 * existing /invite/[token] → /case/[caseId] flow — no changes needed
 * to requireProviderAuth or the case-scoped middleware.
 *
 * All endpoints are staff-session gated. The route resolves the
 * caller's providerId by joining providers.user_id = users.id and
 * refuses when the user isn't linked to a provider.
 */
export const providerMeRoutes = new Hono<ApiBindings>();

providerMeRoutes.use("/v1/provider/me/*", requireStaffAuth);

async function resolveProviderForUser(userId: string): Promise<string | null> {
  // rls: bypass — pre-tenancy provider lookup keyed on the
  // authenticated user's own id.
  const rows = await db()
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(eq(schema.providers.userId, userId))
    .limit(1);
  return rows[0]?.id ?? null;
}

providerMeRoutes.get("/v1/provider/me/cases", async (c) => {
  const auth = c.var.staffAuth;
  const providerId = await resolveProviderForUser(auth.session.userId);
  if (!providerId) {
    // Not a provider — return an empty list rather than 404, so the
    // welcome page can render a benign "no cases" state without
    // treating this as an error condition.
    return c.json({ providerId: null, cases: [] });
  }

  // rls: bypass — cases keyed on providerId (the caller's own
  // provider row). Includes workspaceId in the payload so the FE can
  // present a per-agency label when we grow past a single-agency
  // beta.
  const rows = await db()
    .select({
      id: schema.cases.id,
      status: schema.cases.status,
      specialty: schema.cases.specialty,
      workspaceId: schema.cases.workspaceId,
      targetSubmissionDate: schema.cases.targetSubmissionDate,
      facilityName: schema.facilities.name,
    })
    .from(schema.cases)
    .leftJoin(
      schema.facilityProfiles,
      eq(schema.facilityProfiles.id, schema.cases.facilityProfileId),
    )
    .leftJoin(schema.facilities, eq(schema.facilities.id, schema.facilityProfiles.facilityId))
    .where(eq(schema.cases.providerId, providerId))
    .orderBy(desc(schema.cases.openedAt));

  return c.json({
    providerId,
    cases: rows.map((r) => ({
      id: r.id,
      status: r.status,
      specialty: r.specialty,
      workspaceId: r.workspaceId,
      facilityName: r.facilityName,
      targetSubmissionDate: r.targetSubmissionDate,
    })),
  });
});

providerMeRoutes.post("/v1/provider/me/cases/:caseId/open", async (c) => {
  const auth = c.var.staffAuth;
  const caseId = c.req.param("caseId");
  const providerId = await resolveProviderForUser(auth.session.userId);
  if (!providerId) {
    return c.json(
      { type: "about:blank", title: "Not a provider", status: 403, instance: c.var.requestId },
      403,
    );
  }

  // rls: bypass — case lookup keyed on caseId + the caller's own
  // providerId, so this can only return a case the provider owns.
  const [row] = await db()
    .select({ id: schema.cases.id, workspaceId: schema.cases.workspaceId })
    .from(schema.cases)
    .where(and(eq(schema.cases.id, caseId), eq(schema.cases.providerId, providerId)))
    .limit(1);
  if (!row) {
    return c.json(
      {
        type: "about:blank",
        title: "Case not found for this provider",
        status: 404,
        instance: c.var.requestId,
      },
      404,
    );
  }

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const { token } = await issueCaseAccessToken({
    caseId: row.id,
    providerId,
    workspaceId: row.workspaceId,
    expiresAt,
    issuedByUserId: auth.session.userId,
  });

  await audit({
    workspaceId: row.workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "case_access.self_open",
    targetEntityType: "case",
    targetEntityId: row.id,
    after: { providerId, expiresAt: expiresAt.toISOString() },
    requestId: c.var.requestId,
  });

  const url = new URL(`/invite/${token}`, env().WEB_PUBLIC_URL).toString();
  return c.json({ url, caseId: row.id, expiresAt: expiresAt.toISOString() });
});
