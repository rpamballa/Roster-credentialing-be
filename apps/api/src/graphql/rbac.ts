// GraphQL-side RBAC helper (PROMPT §8 gap #1).
//
// REST writes are gated by the `requireWriterOnMutations` middleware on each
// cockpit sub-router. GraphQL is a single endpoint serving both queries and
// mutations off /graphql, so the same middleware can't distinguish reads
// from writes — we gate at the resolver entry instead.
//
// Each mutation resolver calls `assertWriter(ctx)` before doing any work. A
// viewer membership throws `FORBIDDEN_ROLE`, which Yoga surfaces as a 200
// payload with an `errors` array — the FE treats that identically to a 403.

import { db, schema } from "@cred/db";
import type { MembershipRole } from "@cred/types/domain";
import { and, eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { WRITER_ROLES } from "../middleware/rbac.js";
import type { GqlContext } from "./context.js";

export async function assertWriter(ctx: GqlContext): Promise<void> {
  const { userId, workspaceId } = ctx.tenancy;
  if (!userId) {
    throw new GraphQLError("unauthorized", { extensions: { code: "UNAUTHORIZED" } });
  }
  // rls: bypass — membership lookup is the access check itself.
  const [row] = await db()
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new GraphQLError("no membership for active workspace", {
      extensions: { code: "FORBIDDEN_ROLE" },
    });
  }
  const writerSet = new Set<MembershipRole>(WRITER_ROLES);
  if (!writerSet.has(row.role as MembershipRole)) {
    throw new GraphQLError(
      `role '${row.role}' is not permitted to perform this action`,
      { extensions: { code: "FORBIDDEN_ROLE" } },
    );
  }
}
