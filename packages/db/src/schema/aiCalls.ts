import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

// Every Anthropic call is logged here (PROMPT §4.3 / SPEC §5.4). The table
// drives accuracy tracking and cost monitoring. The raw prompt+response are
// stored only for failed or low-confidence calls; happy-path rows keep only
// metadata to bound storage.
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    task: text("task").notNull(),
    model: text("model").notNull(),
    modelVersion: text("model_version").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    stopReason: text("stop_reason"),
    confidence: integer("confidence_bp"), // basis points; null when not applicable
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: uuid("related_entity_id"),
    error: text("error"),
    promptSnapshot: jsonb("prompt_snapshot"),
    responseSnapshot: jsonb("response_snapshot"),
    timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTask: index("ai_calls_task_idx").on(t.task, t.timestamp),
    byEntity: index("ai_calls_entity_idx").on(t.relatedEntityType, t.relatedEntityId),
  }),
);

export type AiCallRow = typeof aiCalls.$inferSelect;
export type AiCallInsert = typeof aiCalls.$inferInsert;
