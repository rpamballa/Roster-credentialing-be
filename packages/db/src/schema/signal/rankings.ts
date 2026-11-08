import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";
import { signalJobs } from "./jobs.js";

/**
 * Materialized ranked list of providers per job.
 *
 * `entries` is a jsonb array of
 *   `{ provider_id, score, reasons: [{ code, source_lineage }] }`
 * where `source_lineage` is a pointer into `signal_source_lineage`
 * / `signal_extracts` so every reason is explainable. A ranking is
 * immutable — a re-run writes a new row with a newer `ranked_at`.
 */
export interface SignalRankingReason {
  code: string;
  source_lineage?: { id?: string; table?: string; row_id?: string };
}

export interface SignalRankingEntry {
  provider_id: string;
  score: number;
  reasons: SignalRankingReason[];
}

export const signalRankings = pgTable(
  "signal_rankings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => signalJobs.id, { onDelete: "cascade" }),
    rankedAt: timestamp("ranked_at", { withTimezone: true }).defaultNow().notNull(),
    entries: jsonb("entries").$type<SignalRankingEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_rankings_workspace_idx").on(t.workspaceId),
    byJobRanked: index("signal_rankings_job_ranked_idx").on(t.jobId, t.rankedAt),
  }),
);

export type SignalRankingRow = typeof signalRankings.$inferSelect;
export type SignalRankingInsert = typeof signalRankings.$inferInsert;
