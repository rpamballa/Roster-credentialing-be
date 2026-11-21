import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users.js";
import { workspaces } from "../workspaces.js";

/**
 * Status of an agency-local onboarding gap:
 *   open     → raised during onboarding, no action taken yet
 *   planned  → acknowledged, on the roadmap
 *   wontfix  → decided not to address
 *   resolved → shipped — product now handles it
 */
export const signalOnboardingGapStatusEnum = pgEnum("signal_onboarding_gap_status", [
  "open",
  "planned",
  "wontfix",
  "resolved",
]);

export type SignalOnboardingGapStatus = (typeof signalOnboardingGapStatusEnum.enumValues)[number];

/**
 * Agency-local log of "we noticed something during onboarding we
 * can't model yet". Fed into the onboarding runbook agent and into
 * product-level follow-up triage.
 */
export const signalOnboardingGaps = pgTable(
  "signal_onboarding_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    status: signalOnboardingGapStatusEnum("status").notNull().default("open"),
    raisedBy: uuid("raised_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index("signal_onboarding_gaps_workspace_idx").on(t.workspaceId),
    byWorkspaceStatus: index("signal_onboarding_gaps_workspace_status_idx").on(
      t.workspaceId,
      t.status,
    ),
  }),
);

export type SignalOnboardingGapRow = typeof signalOnboardingGaps.$inferSelect;
export type SignalOnboardingGapInsert = typeof signalOnboardingGaps.$inferInsert;
