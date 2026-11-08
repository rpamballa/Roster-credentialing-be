import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";
import { signalConversations } from "./conversations.js";

/**
 * Durable store for Signal eval harness runs.
 *
 * `aggregate` is the precision@K summary; `per_req` is the full
 * per-req breakdown (fixture req id, ranker top-K, precision). A
 * recruiter debugging a ranking regression can pull this straight
 * off the row without re-running the harness.
 *
 * Runs are append-only — a re-run writes a new row.
 */
export interface SignalEvalRunAggregate {
  meanPrecisionAtK: number;
  passedCount: number;
  failedCount: number;
}

export interface SignalEvalRunPerReq {
  reqId: string;
  precisionAtK: number;
  rankerTop: string[];
  expectedTop: string[];
  hits: string[];
  misses: string[];
  reasonsMatched: Record<string, string[]>;
}

export const signalEvalRuns = pgTable(
  "signal_eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => signalConversations.id, {
      onDelete: "set null",
    }),
    suite: text("suite").notNull(),
    fixture: text("fixture").notNull(),
    labelSource: text("label_source").notNull(),
    k: integer("k").notNull(),
    status: text("status").notNull().default("completed"),
    meanPrecisionAtK: numeric("mean_precision_at_k", { precision: 6, scale: 4 }).notNull(),
    passedCount: integer("passed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    aggregate: jsonb("aggregate").$type<SignalEvalRunAggregate>().notNull().default({
      meanPrecisionAtK: 0,
      passedCount: 0,
      failedCount: 0,
    }),
    perReq: jsonb("per_req").$type<SignalEvalRunPerReq[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_eval_runs_workspace_idx").on(t.workspaceId),
    byWorkspaceCreated: index("signal_eval_runs_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    byConversation: index("signal_eval_runs_conversation_idx").on(t.conversationId),
  }),
);

export type SignalEvalRunRow = typeof signalEvalRuns.$inferSelect;
export type SignalEvalRunInsert = typeof signalEvalRuns.$inferInsert;
