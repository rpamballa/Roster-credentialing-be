// THE ONE TENANCY MIDDLEWARE — PROMPT §4.1.
//
// Every tenant-scoped DB call inside a request handler MUST go through
// `withTenancy(c.var.tenancy, ...)`. The middleware itself does not open the
// transaction (that would hold a connection for the entire request); instead
// it asserts and exposes the tenancy context.
//
// Raw SQL that bypasses `withTenancy` requires `// rls: bypass — <reason>`.

import { type TenancyContext, db, schema } from "@cred/db";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiBindings } from "../types.js";

declare module "hono" {
  interface ContextVariableMap {
    tenancy: TenancyContext;
  }
}

function forbidden(c: Context<ApiBindings>, title = "Forbidden"): Response {
  return c.json({ type: "about:blank", title, status: 403, instance: c.var.requestId }, 403);
}

function unauthorized(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
    401,
  );
}

/** Staff: set tenancy from the active workspace on a staff session. */
export const requireTenancy: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const auth = c.var.auth;
  if (!auth || auth.session.kind !== "staff") return unauthorized(c);

  const workspaceId = auth.session.activeWorkspaceId;
  if (!workspaceId) {
    return c.json(
      {
        type: "about:blank",
        title: "No active workspace",
        status: 403,
        detail: "Select a workspace before calling this endpoint.",
        instance: c.var.requestId,
      },
      403,
    );
  }

  // rls: bypass — membership existence is what gates RLS itself.
  const rows = await db()
    .select({ workspaceId: schema.memberships.workspaceId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, auth.session.userId),
        eq(schema.memberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return forbidden(c);

  c.set("tenancy", { workspaceId, userId: auth.session.userId });
  await next();
};

/**
 * Provider: set tenancy from the case's workspace.
 *
 * Reads from `c.var.providerAuth` — which `requireProviderAuth` sets
 * for both genuine provider sessions (magic-link) and signed-in staff
 * sessions whose user is linked to the case's provider (see
 * middleware/session.ts). Neither raw c.var.auth kind is checked
 * here because the synthesized providerAuth already carries the
 * verified providerId + caseWorkspaceId.
 *
 * The staff userId is threaded into tenancy.userId when we can — it
 * feeds RLS's `app.current_user_id` so audit rows land with a real
 * actor. Provider magic-link sessions have no users.id, so we leave
 * userId null there.
 */
export const requireProviderTenancy: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const providerAuth = c.var.providerAuth;
  if (!providerAuth) return unauthorized(c);

  const rawAuth = c.var.auth;
  const staffUserId = rawAuth && rawAuth.session.kind === "staff" ? rawAuth.session.userId : null;

  c.set("tenancy", {
    workspaceId: providerAuth.session.caseWorkspaceId,
    userId: staffUserId,
  });
  await next();
};
