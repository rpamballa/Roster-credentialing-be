import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";
import { signalConversations } from "./conversations.js";

/**
 * Structured facets lifted out of a conversation —
 * e.g. `{ facet: "availability.start_date", value: { date:
 * "2025-02-15" }, confidence: 0.82, source_span: { char_start,
 * char_end } }`. Every row in `signal_rankings.entries[].reasons[]`
 * ultimately traces back to one of these.
 */
export const signalExtracts = pgTable(
  "signal_extracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => signalConversations.id, { onDelete: "cascade" }),
    facet: text("facet").notNull(),
    value: jsonb("value").$type<unknown>(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    sourceSpan: jsonb("source_span").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_extracts_workspace_idx").on(t.workspaceId),
    byConversation: index("signal_extracts_conversation_idx").on(t.conversationId),
    byWorkspaceFacet: index("signal_extracts_workspace_facet_idx").on(t.workspaceId, t.facet),
  }),
);

export type SignalExtractRow = typeof signalExtracts.$inferSelect;
export type SignalExtractInsert = typeof signalExtracts.$inferInsert;
