import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users.js";
import { workspaces } from "../workspaces.js";

/**
 * Agency-local, append-only key/value store.
 *
 * Every PUT inserts a new row. The scoped DAL reads the latest row
 * per (workspace_id, scope, key) via `ORDER BY created_at DESC LIMIT
 * 1`. History stays behind for audit and rollback — "what did we tell
 * Signal last Tuesday" is answerable without a backup.
 *
 * `scope` is a free-form namespace (e.g. `field_mapping`, `playbook`,
 * `narrative_context`); `key` is the concrete setting inside it (e.g.
 * `candidate.email`, `inbound_call_checklist`).
 *
 * See migration 0026.
 */
export const signalWorkspaceConfig = pgTable(
  "signal_workspace_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // `created_by` nulls out if the user is deleted — the config row
    // still matters as agency context even without the author.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    byWorkspace: index("signal_workspace_config_workspace_idx").on(t.workspaceId),
    byLookup: index("signal_workspace_config_lookup_idx").on(
      t.workspaceId,
      t.scope,
      t.key,
      t.createdAt.desc(),
    ),
  }),
);

export type SignalWorkspaceConfigRow = typeof signalWorkspaceConfig.$inferSelect;
export type SignalWorkspaceConfigInsert = typeof signalWorkspaceConfig.$inferInsert;
