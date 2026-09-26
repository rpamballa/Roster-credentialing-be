import { db, schema } from "@cred/db";
import type { MeResponse } from "@cred/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireStaffAuth } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

export const meRoutes = new Hono<ApiBindings>();

// Scope auth to the exact paths this router serves. `use("*", ...)` would
// flatten onto the main app via `app.route("/", meRoutes)` and 401 every
// other route in the system (including health checks and the demo-signin
// endpoint).
meRoutes.use("/me", requireStaffAuth);
meRoutes.use("/v1/workspace/me", requireStaffAuth);

meRoutes.get("/me", async (c) => {
  const auth = c.var.staffAuth;

  // rls: bypass — listing a user's own memberships before any workspace
  // context is selected. The query is keyed on the authenticated user id.
  const memberships = await db()
    .select({
      workspaceId: schema.memberships.workspaceId,
      workspaceSlug: schema.workspaces.slug,
      workspaceName: schema.workspaces.name,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, auth.session.userId));

  // rls: bypass — fetching the authenticated user's own row.
  const userRows = await db()
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, auth.session.userId))
    .limit(1);

  // rls: bypass — providers is workspace-independent; we look this user
  // up by user_id to expose the provider-portal path to the FE. Null
  // for staff-only users; non-null triggers the /welcome landing
  // instead of /cockpit in the cockpit layout.
  //
  // Two lookups, tried in order:
  //   1. providers.user_id = users.id  — the modern link, set by the
  //      /auth/password/set invite-redemption path.
  //   2. providers.email  = users.email — a lazy heal for providers
  //      created before the users→providers link existed (magic-link
  //      redemptions pre-dating migration 0012). When we find one,
  //      we UPDATE the providers row to persist the link so every
  //      later call skips this fallback.
  //
  // The lazy heal is deliberately narrow: it only fires when the
  // linked lookup misses, so a mis-typed user email never overwrites
  // an existing user_id.
  let providerRows = await db()
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(eq(schema.providers.userId, auth.session.userId))
    .limit(1);

  if (providerRows.length === 0) {
    const linked = await db()
      .update(schema.providers)
      .set({ userId: auth.session.userId, updatedAt: new Date() })
      .where(
        and(
          eq(sql`lower(${schema.providers.email})`, auth.session.email.toLowerCase()),
          isNull(schema.providers.userId),
        ),
      )
      .returning({ id: schema.providers.id });
    providerRows = linked;
  }

  const body: MeResponse = {
    userId: auth.session.userId,
    email: auth.session.email,
    name: userRows[0]?.name ?? null,
    memberships,
    providerId: providerRows[0]?.id ?? null,
  };
  return c.json(body);
});

/**
 * GET /v1/workspace/me — the active workspace's display context.
 *
 * The cockpit layout calls this on every request to render the workspace
 * name + branding in the top bar. Lives under meRoutes because it's
 * session-scoped (same as `/me`) — but unlike `/me`, it requires an
 * activated workspace and returns the row for that one workspace, not all
 * the memberships.
 *
 * Branding columns aren't in the schema yet, so we return sane defaults for
 * the non-locked branding fields. When the schema grows a `branding` jsonb
 * column, swap the defaults out here.
 */
meRoutes.get("/v1/workspace/me", async (c) => {
  const auth = c.var.staffAuth;
  const workspaceId = auth.session.activeWorkspaceId;
  if (!workspaceId) {
    return c.json(
      {
        type: "about:blank",
        title: "No active workspace",
        status: 404,
        instance: c.var.requestId,
      },
      404,
    );
  }

  // rls: bypass — workspace identity lookup is keyed on the session's
  // already-validated activeWorkspaceId; tenancy is implicit.
  const [ws] = await db()
    .select({
      id: schema.workspaces.id,
      type: schema.workspaces.type,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  if (!ws) {
    return c.json(
      {
        type: "about:blank",
        title: "Workspace not found",
        status: 404,
        instance: c.var.requestId,
      },
      404,
    );
  }

  return c.json({
    id: ws.id,
    type: ws.type,
    branding: {
      displayName: ws.name,
      logoUrl: null,
      accent: null,
      supportEmail: null,
    },
  });
});
