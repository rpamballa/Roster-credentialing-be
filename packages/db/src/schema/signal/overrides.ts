import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users.js";
import { workspaces } from "../workspaces.js";
import { signalJobs } from "./jobs.js";
import { signalProviders } from "./providers.js";

/**
 * Human overrides on a ranking (pin / unpin a provider for a job).
 * Captured with the reason so we can learn from the correction in
 * a later ranking iteration.
 *
 * `direction` is intentionally `text` (not an enum) to keep the
 * vocabulary open while v0 settles: expected values are `pin`,
 * `unpin`, and `demote`.
 */
export const signalOverrides = pgTable(
  "signal_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => signalJobs.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => signalProviders.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    direction: text("direction").notNull(),
    reasonText: text("reason_text"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_overrides_workspace_idx").on(t.workspaceId),
    byJob: index("signal_overrides_job_idx").on(t.jobId),
    byProvider: index("signal_overrides_provider_idx").on(t.providerId),
  }),
);

export type SignalOverrideRow = typeof signalOverrides.$inferSelect;
export type SignalOverrideInsert = typeof signalOverrides.$inferInsert;
