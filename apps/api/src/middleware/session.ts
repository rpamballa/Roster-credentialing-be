import { type ProviderSessionPayload, type StaffSessionPayload, readSession } from "@cred/auth";
import { db, schema } from "@cred/db";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ApiBindings } from "../types.js";

export const SESSION_COOKIE = "cred_sid";

/** Populate c.var.auth if a valid session cookie is present. Does not gate. */
export const sessionLoader: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const session = await readSession(sid);
    if (session) c.set("auth", { sid, session });
  }
  await next();
};

function unauthorized(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
    401,
  );
}

/** Gate: any authenticated session. */
export const requireAuth: MiddlewareHandler<ApiBindings> = async (c, next) => {
  if (!c.var.auth) return unauthorized(c);
  await next();
};

/** Gate: staff session only. Narrows c.var.staffAuth for downstream handlers. */
export const requireStaffAuth: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const auth = c.var.auth;
  if (!auth || auth.session.kind !== "staff") return unauthorized(c);
  c.set("staffAuth", { sid: auth.sid, session: auth.session });
  await next();
};

/**
 * Gate: any session whose caller effectively acts as the provider on
 * this case. Two acceptance paths:
 *
 *   1. Case-scope provider session (magic-link redemption). This is the
 *      original onboarding path — a first-time provider who's clicked
 *      an invite email and hasn't set a password yet.
 *
 *   2. Staff-shape session whose user is linked (via
 *      providers.user_id → users.id) to the provider that owns the
 *      case in the URL. This covers the everyday case: a provider
 *      who's set a password and signed in normally.
 *
 * Both paths land the same synthetic providerAuth downstream so the
 * route handlers don't need to branch on session kind. Requires
 * a :caseId route param — routes that don't have one shouldn't use
 * this guard.
 */
export const requireProviderAuth: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const auth = c.var.auth;
  if (!auth) return unauthorized(c);

  // Case 1 — genuine provider session (magic-link).
  if (auth.session.kind === "provider") {
    c.set("providerAuth", { sid: auth.sid, session: auth.session });
    return await next();
  }

  // Case 2 — staff session whose user is the provider on this case.
  if (auth.session.kind === "staff") {
    // caseId is parsed from the URL directly rather than
    // c.req.param("caseId") because this middleware is mounted with
    // caseRoutes.use("/v1/cases/*") — the wildcard doesn't populate
    // route params, so c.req.param returns undefined. Match on
    // /v1/cases/<uuid>/... at the path start.
    const pathMatch = c.req.path.match(
      /^\/v1\/cases\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
    );
    const caseIdParam = pathMatch?.[1];
    if (!caseIdParam) return unauthorized(c);

    // Join cases → providers, filtered by "provider is linked to the
    // authenticated user AND owns this case". A miss on either
    // predicate short-circuits to 401 without leaking which condition
    // failed.
    const rows = await db()
      .select({
        caseId: schema.cases.id,
        providerId: schema.cases.providerId,
        caseWorkspaceId: schema.cases.workspaceId,
      })
      .from(schema.cases)
      .innerJoin(
        schema.providers,
        and(
          eq(schema.providers.id, schema.cases.providerId),
          eq(schema.providers.userId, auth.session.userId),
        ),
      )
      .where(eq(schema.cases.id, caseIdParam))
      .limit(1);
    const row = rows[0];
    if (!row) return unauthorized(c);

    // Synthesize a ProviderSessionPayload for downstream handlers.
    // Keeping the same shape means the route code doesn't branch on
    // how the session was established.
    c.set("providerAuth", {
      sid: auth.sid,
      session: {
        kind: "provider",
        providerId: row.providerId,
        caseId: row.caseId,
        caseWorkspaceId: row.caseWorkspaceId,
        createdAt: new Date().toISOString(),
      },
    });
    return await next();
  }

  return unauthorized(c);
};

declare module "hono" {
  interface ContextVariableMap {
    staffAuth: { sid: string; session: StaffSessionPayload };
    providerAuth: { sid: string; session: ProviderSessionPayload };
  }
}
