import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cases } from "./cases.js";
import { workspaces } from "./workspaces.js";

// One thread per (case, recipient). The thread tracks scheduled and sent
// messages and is paused/resumed by the Temporal outreach workflow.
export const outreachThreads = pgTable(
  "outreach_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    recipientKind: text("recipient_kind").notNull(), // 'provider' | 'reference'
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email"),
    recipientPhone: text("recipient_phone"),
    status: text("status").notNull().default("active"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCase: index("outreach_threads_case_idx").on(t.caseId),
    byWorkspace: index("outreach_threads_workspace_idx").on(t.workspaceId, t.status),
  }),
);

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => outreachThreads.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // 'email' | 'sms'
    direction: text("direction").notNull(), // 'out' | 'in'
    template: text("template"),
    body: text("body"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byThread: index("outreach_messages_thread_idx").on(t.threadId, t.createdAt),
  }),
);

// Reference contacts captured per case.
export const references = pgTable(
  "references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    relationship: text("relationship"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").notNull().default("pending"),
    responseFields: jsonb("response_fields").$type<Record<string, unknown>>(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCase: index("references_case_idx").on(t.caseId),
  }),
);

export const referenceAccessTokens = pgTable(
  "reference_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    referenceId: uuid("reference_id")
      .notNull()
      .references(() => references.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byReference: index("reference_access_tokens_reference_idx").on(t.referenceId),
  }),
);

export type OutreachThreadRow = typeof outreachThreads.$inferSelect;
export type OutreachThreadInsert = typeof outreachThreads.$inferInsert;
export type OutreachMessageRow = typeof outreachMessages.$inferSelect;
export type OutreachMessageInsert = typeof outreachMessages.$inferInsert;
export type ReferenceRow = typeof references.$inferSelect;
export type ReferenceInsert = typeof references.$inferInsert;
export type ReferenceAccessTokenRow = typeof referenceAccessTokens.$inferSelect;
export type ReferenceAccessTokenInsert = typeof referenceAccessTokens.$inferInsert;
