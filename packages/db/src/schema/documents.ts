import type { ExtractedField } from "@cred/types/domain";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { documentSourceEnum, documentTypeEnum, extractionStatusEnum } from "./enums.js";
import { providers } from "./providers.js";
import { users } from "./users.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    documentType: documentTypeEnum("document_type").notNull(),
    fileUri: text("file_uri").notNull(),
    contentHash: text("content_hash"),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    pageCount: integer("page_count"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    source: documentSourceEnum("source").notNull(),
    extractionStatus: extractionStatusEnum("extraction_status").notNull().default("pending"),
    extractedFields: jsonb("extracted_fields").$type<ExtractedField[]>(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    classifierConfidence: integer("classifier_confidence"),
  },
  (t) => ({
    byProvider: index("documents_provider_idx").on(t.providerId),
    byType: index("documents_type_idx").on(t.providerId, t.documentType),
    byContentHash: index("documents_content_hash_idx").on(t.contentHash),
  }),
);

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentInsert = typeof documents.$inferInsert;
