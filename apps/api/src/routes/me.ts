import { db, schema } from "@cred/db";
import type { MeResponse } from "@cred/types";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireStaffAuth } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

export const meRoutes = new Hono<ApiBindings>();

meRoutes.use("*", requireStaffAuth);

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

  const body: MeResponse = {
    userId: auth.session.userId,
    email: auth.session.email,
    name: userRows[0]?.name ?? null,
    memberships,
  };
  return c.json(body);
});
