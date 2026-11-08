import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";
import { signalProviders } from "./providers.js";

/**
 * A recruiter ↔ provider touch. `provider_id` is nullable because
 * an inbound thread may precede entity resolution (we land the
 * conversation row, run ER, then back-fill the provider pointer).
 *
 * `source_ref` carries the pointer back to the origin — e.g.
 * `{ system: "resend", message_id: "msg_abc" }` or `{ system:
 * "inbound_emails", id: "<uuid>" }`. The cross-table lineage that
 * matches `source_ref` lives in `signal_source_lineage`.
 */
export const signalConversations = pgTable(
  "signal_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id").references(() => signalProviders.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    summary: text("summary"),
    consentState: text("consent_state").notNull().default("unknown"),
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_conversations_workspace_idx").on(t.workspaceId),
    byWorkspaceOccurredAt: index("signal_conversations_workspace_occurred_at_idx").on(
      t.workspaceId,
      t.occurredAt,
    ),
    byProvider: index("signal_conversations_provider_idx").on(t.providerId),
  }),
);

export type SignalConversationRow = typeof signalConversations.$inferSelect;
export type SignalConversationInsert = typeof signalConversations.$inferInsert;
