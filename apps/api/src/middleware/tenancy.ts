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

/** Provider: set tenancy from the case's workspace on a provider session. */
export const requireProviderTenancy: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const auth = c.var.auth;
  if (!auth || auth.session.kind !== "provider") return unauthorized(c);
  // c.set returns void so it can't be in a destructure shape.
  c.set("tenancy", { workspaceId: auth.session.caseWorkspaceId, userId: null });
  c.set("providerAuth", { sid: auth.sid, session: auth.session });
  await next();
};
