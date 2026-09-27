import { db, schema } from "@cred/db";
import type { MeResponse } from "@cred/types";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { requireAuth, requireStaffAuth } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

export const meRoutes = new Hono<ApiBindings>();

/**
 * /me accepts EITHER a staff or provider session. Staff sessions get
 * the full viewer (memberships, providerId link, name). Provider
 * magic-link sessions get a minimal viewer keyed on the session's
 * providerId — no memberships, no user identity beyond what the
 * provider row carries. This keeps the FE getViewer() simple: one
 * fetch, one shape, one redirect on 401.
 */
meRoutes.use("/me", requireAuth);
meRoutes.use("/v1/workspace/me", requireStaffAuth);

meRoutes.get("/me", async (c) => {
  const auth = c.var.auth;
  if (!auth) {
    return c.json(
      { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
      401,
    );
  }

  if (auth.session.kind === "provider") {
    return handleProviderMe(c, auth.session.providerId);
  }
  c.set("staffAuth", { sid: auth.sid, session: auth.session });
  return handleStaffMe(c);
});

// The staff-session branch — original behavior, kept structurally the
// same so the tests + FE contract stay stable.
async function handleStaffMe(c: Context<ApiBindings>) {
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
  // Also pulls the provider's first/last name so /me can fall back to
  // them when users.name is null — legacy magic-link accounts often
  // have no users.name set, which makes /welcome greet the provider
  // as "Welcome back, provider." instead of by name.
  const providerRows = await db()
    .select({
      id: schema.providers.id,
      firstName: schema.providers.firstName,
      lastName: schema.providers.lastName,
    })
    .from(schema.providers)
    .where(eq(schema.providers.userId, auth.session.userId))
    .limit(1);

  const providerRow = providerRows[0];
  const providerName = providerRow
    ? `${providerRow.firstName} ${providerRow.lastName}`.trim() || null
    : null;

  const body: MeResponse = {
    userId: auth.session.userId,
    email: auth.session.email,
    name: userRows[0]?.name ?? providerName,
    memberships,
    providerId: providerRow?.id ?? null,
  };
  return c.json(body);
}

// The provider-session branch — returns a minimal viewer shape. No
// users row lookup because a magic-link provider session isn't tied
// to a users.id.
async function handleProviderMe(c: Context<ApiBindings>, providerId: string) {
  const rows = await db()
    .select({
      id: schema.providers.id,
      firstName: schema.providers.firstName,
      lastName: schema.providers.lastName,
      email: schema.providers.email,
    })
    .from(schema.providers)
    .where(eq(schema.providers.id, providerId))
    .limit(1);
  const provider = rows[0];
  const name = provider ? `${provider.firstName} ${provider.lastName}`.trim() || null : null;

  // MeResponse shape kept identical to staff so getViewer() on the FE
  // doesn't need a discriminated union. providerId is populated,
  // memberships is empty (magic-link providers aren't staff).
  const body: MeResponse = {
    userId: providerId, // best-available identifier for provider-only sessions
    email: provider?.email ?? "",
    name,
    memberships: [],
    providerId,
  };
  return c.json(body);
}

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
