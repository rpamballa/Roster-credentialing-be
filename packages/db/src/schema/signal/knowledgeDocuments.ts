import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users.js";
import { workspaces } from "../workspaces.js";

/**
 * Agency-local knowledge base documents.
 *
 * Each row is one markdown artifact (SOP, playbook, placement
 * narrative, style guide…). Chunks + embeddings live in the child
 * `signal_knowledge_chunks` table. Delete is soft (sets `deleted_at`)
 * so an accidental drop doesn't lose the embedded corpus; the scoped
 * DAL filters `deleted_at IS NULL` on `list()` and `findById()`.
 *
 * See migration 0026 and `packages/signal-knowledge`.
 */
export const signalKnowledgeDocuments = pgTable(
  "signal_knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index("signal_knowledge_documents_workspace_idx").on(t.workspaceId),
    byWorkspaceLive: index("signal_knowledge_documents_workspace_live_idx")
      .on(t.workspaceId, t.createdAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export type SignalKnowledgeDocumentRow = typeof signalKnowledgeDocuments.$inferSelect;
export type SignalKnowledgeDocumentInsert = typeof signalKnowledgeDocuments.$inferInsert;
