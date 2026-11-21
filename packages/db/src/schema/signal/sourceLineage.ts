import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";

/**
 * Lineage — every Signal row has a trail back to the external
 * system it was derived from. `canonical_table` + `canonical_id`
 * name the Signal row; `external_system` + `external_id` name the
 * origin (e.g. `('inbound_emails', <uuid>)`, `('bullhorn', '12345')`).
 *
 * A single canonical row may accumulate multiple lineage entries
 * over time as it is re-synced from different sources. The unique
 * index on the four-tuple below is what makes `recordLineage` an
 * upsert rather than an append.
 */
export const signalSourceLineage = pgTable(
  "signal_source_lineage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalTable: text("canonical_table").notNull(),
    canonicalId: uuid("canonical_id").notNull(),
    externalSystem: text("external_system").notNull(),
    externalId: text("external_id").notNull(),
    lastSynced: timestamp("last_synced", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_source_lineage_workspace_idx").on(t.workspaceId),
    byCanonical: index("signal_source_lineage_canonical_idx").on(t.canonicalTable, t.canonicalId),
    uq: uniqueIndex("signal_source_lineage_uq").on(
      t.workspaceId,
      t.canonicalTable,
      t.canonicalId,
      t.externalSystem,
      t.externalId,
    ),
  }),
);

export type SignalSourceLineageRow = typeof signalSourceLineage.$inferSelect;
export type SignalSourceLineageInsert = typeof signalSourceLineage.$inferInsert;
