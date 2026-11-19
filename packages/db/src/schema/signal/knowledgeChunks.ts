import { customType, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";
import { signalKnowledgeDocuments } from "./knowledgeDocuments.js";

/**
 * pgvector column type.
 *
 * Drizzle 0.36 doesn't have a built-in `vector` column, and the
 * pgvector SDK is a thin wrapper that would add a dependency we can
 * get by without. Instead we declare the column via `customType` so
 * SELECTs receive the pgvector text form (e.g. `"[0.1,0.2,…]"`) and
 * INSERTs serialize JS `number[]` to the same shape.
 *
 * The on-wire representation is pgvector's canonical text form; both
 * directions are cheap.
 */
export const vectorColumn = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // pgvector returns `"[0.1,0.2,…]"`; strip brackets and parse.
    if (!value) return [];
    const inner = value.startsWith("[") ? value.slice(1, -1) : value;
    if (!inner) return [];
    return inner.split(",").map((n) => Number(n));
  },
});

/**
 * Embedded chunk rows for `signal_knowledge_documents`.
 *
 * `workspace_id` is DENORMALIZED from the parent document. This is
 * load-bearing for isolation: the vector similarity query runs
 * against the IVFFlat index, which has no awareness of the parent
 * document's workspace. By keeping workspace_id on the chunk itself
 * we can filter in the same WHERE as the ORDER BY and the planner
 * can push it down into the index scan.
 *
 * Dimension 1536 matches the OpenAI / Voyage-3 family — the
 * scaffolding ships a deterministic hashing embedder at this
 * dimension so a paid embedder can be swapped in later without a
 * re-migration. See `packages/signal-knowledge/src/embedding.ts`.
 */
export const signalKnowledgeChunks = pgTable(
  "signal_knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => signalKnowledgeDocuments.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    chunkText: text("chunk_text").notNull(),
    embedding: vectorColumn("embedding", { dimensions: 1536 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_knowledge_chunks_workspace_idx").on(t.workspaceId),
    byDocument: index("signal_knowledge_chunks_document_idx").on(t.documentId),
  }),
);

export type SignalKnowledgeChunkRow = typeof signalKnowledgeChunks.$inferSelect;
export type SignalKnowledgeChunkInsert = typeof signalKnowledgeChunks.$inferInsert;

/** The embedding dimension — single source of truth for the embedder. */
export const KNOWLEDGE_EMBEDDING_DIM = 1536;
