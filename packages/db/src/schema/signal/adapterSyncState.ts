import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";

/**
 * Per-(workspace, adapter) scheduler state.
 *
 * Mirrors `@cred/signal-core/circuit-breaker` across restarts: the
 * breaker drives live decisions within a process lifetime, this row
 * drives recovery and the health dashboard.
 *
 * `cursor` is adapter-defined jsonb — Bullhorn may store
 * `{ lastModifiedAt }`, Gmail may store `{ historyId }`, the roster-
 * internal adapter does not use it at all. The scheduler never
 * introspects the shape; it only persists whatever the adapter hands
 * back from its last successful `sync()`.
 *
 * `breaker_state` is text (not an enum) so adapters can surface a
 * nuanced state like 'disabled' later without a migration. The DB-level
 * CHECK constraint still caps the enumerable set to ('closed', 'open',
 * 'half_open'). Updating the allowed set is a one-line ALTER on that
 * constraint, not a type migration.
 */
export const signalAdapterSyncState = pgTable(
  "signal_adapter_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    adapter: text("adapter").notNull(),
    cursor: jsonb("cursor"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    breakerState: text("breaker_state").notNull().default("closed"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceAdapterUq: uniqueIndex("signal_adapter_sync_state_workspace_adapter_uq").on(
      t.workspaceId,
      t.adapter,
    ),
    byWorkspace: index("signal_adapter_sync_state_workspace_idx").on(t.workspaceId),
    byBreakerState: index("signal_adapter_sync_state_breaker_state_idx").on(t.breakerState),
  }),
);

export type SignalAdapterSyncStateRow = typeof signalAdapterSyncState.$inferSelect;
export type SignalAdapterSyncStateInsert = typeof signalAdapterSyncState.$inferInsert;
