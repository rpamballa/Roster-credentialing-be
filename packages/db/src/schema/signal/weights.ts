import { index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";

/**
 * Per-workspace facet weights for the Signal ranker's learning loop.
 *
 * Overrides captured in `signal_overrides` are replayed by the learn
 * worker (`packages/signal-learn/src/apply.ts`) — a promote nudges the
 * matching facet's weight up, a demote nudges it down. The ranker then
 * reads these weights when scoring a facet on a candidate, so a
 * workspace's recruiter corrections bend its own future rankings.
 *
 * Weights are strictly per-tenant. No shared classifier: borrowing one
 * tenant's correction history for another leaks recruiter judgement
 * across agencies. The unique index on (workspace_id, facet_key) plus
 * FK ON DELETE CASCADE make the isolation a physical property of the
 * table, not just a convention.
 */
export const signalWeights = pgTable(
  "signal_weights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    facetKey: text("facet_key").notNull(),
    weight: numeric("weight", { precision: 10, scale: 4 }).notNull().default("1.0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_weights_workspace_idx").on(t.workspaceId),
    uniqWorkspaceFacet: uniqueIndex("signal_weights_workspace_facet_uq").on(
      t.workspaceId,
      t.facetKey,
    ),
  }),
);

export type SignalWeightRow = typeof signalWeights.$inferSelect;
export type SignalWeightInsert = typeof signalWeights.$inferInsert;
