import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

// SPEC §5.5 — every state-changing operation writes one entry through the
// audit wrapper. PHI fields are redacted in beforeState / afterState.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    action: text("action").notNull(),
    targetEntityType: text("target_entity_type").notNull(),
    targetEntityId: uuid("target_entity_id").notNull(),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspaceTime: index("audit_log_workspace_time_idx").on(t.workspaceId, t.timestamp),
    byTarget: index("audit_log_target_idx").on(t.targetEntityType, t.targetEntityId),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
