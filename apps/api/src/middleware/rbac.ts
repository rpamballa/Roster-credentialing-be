// Role-based access control middleware (PROMPT §8 gap #1).
//
// Runs AFTER `requireStaffAuth + requireTenancy` and BEFORE a handler. Joins
// the `memberships` row for the session's user + active workspace and 403s
// if the role isn't in the allowed set. Read endpoints stay open to every
// membership role; write endpoints call this with the canonical writer set
// (`owner | admin | specialist`) — viewer membership therefore gets
// READ-everywhere, WRITE-nowhere.
//
// Returns RFC 7807 problem+json on refusal, same shape used elsewhere in
// the API so frontends can branch on `status === 403`.

import { db, schema } from "@cred/db";
import type { MembershipRole } from "@cred/types/domain";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiBindings } from "../types.js";

function forbidden(c: Context<ApiBindings>, detail: string): Response {
  return c.json(
    {
      type: "https://errors.cred/auth/forbidden_role",
      title: "Forbidden",
      status: 403,
      detail,
      instance: c.var.requestId,
    },
    403,
  );
}

/**
 * Gate a handler on the session's membership role for the active workspace.
 *
 * Requires `requireStaffAuth + requireTenancy` to have already run; otherwise
 * the auth context isn't populated and we 403 defensively rather than crash.
 */
export function requireRole(roles: readonly MembershipRole[]): MiddlewareHandler<ApiBindings> {
  const allowed = new Set<MembershipRole>(roles);
  return async (c, next) => {
    const auth = c.var.staffAuth;
    const tenancy = c.var.tenancy;
    if (!auth || !tenancy) {
      return forbidden(c, "Missing staff session or workspace tenancy.");
    }

    // rls: bypass — membership lookup is the access check itself; can't gate
    // a workspace-scoped query on a role we haven't established yet.
    const [row] = await db()
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, auth.session.userId),
          eq(schema.memberships.workspaceId, tenancy.workspaceId),
        ),
      )
      .limit(1);

    if (!row) {
      return forbidden(c, "No membership row for the active workspace.");
    }
    if (!allowed.has(row.role as MembershipRole)) {
      return forbidden(
        c,
        `Role '${row.role}' is not permitted to perform this action.`,
      );
    }

    await next();
  };
}

/** Canonical writer set for cockpit mutations. */
export const WRITER_ROLES: readonly MembershipRole[] = ["owner", "admin", "specialist"];

/** Shorthand: every cockpit write goes through this. */
export const requireWriter: MiddlewareHandler<ApiBindings> = requireRole(WRITER_ROLES);

/**
 * Method-aware writer gate. Skips GET/HEAD/OPTIONS so a single sub-router-level
 * `use("/v1/cockpit/*", ...)` registration covers every current and future
 * mutation without per-handler decoration — a viewer can still read but every
 * mutating verb (POST/PUT/PATCH/DELETE) flows through requireWriter.
 */
export const requireWriterOnMutations: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  return requireWriter(c, next);
};
