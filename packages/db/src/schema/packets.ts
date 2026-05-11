import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cases } from "./cases.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const attestations = pgTable(
  "attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    docusignEnvelopeId: text("docusign_envelope_id").notNull().unique(),
    text: text("text").notNull(),
    status: text("status").notNull().default("sent"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCase: index("attestations_case_idx").on(t.caseId),
  }),
);

export const packets = pgTable(
  "packets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fileUri: text("file_uri").notNull(),
    contentHash: text("content_hash").notNull(),
    provenance: jsonb("provenance")
      .$type<{
        modelVersions: Record<string, string>;
        documentIds: string[];
        facilityProfileVersion: number;
      }>()
      .notNull(),
    assembledAt: timestamp("assembled_at", { withTimezone: true }).defaultNow().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    byCase: index("packets_case_idx").on(t.caseId, t.assembledAt),
  }),
);

export type AttestationRow = typeof attestations.$inferSelect;
export type AttestationInsert = typeof attestations.$inferInsert;
export type PacketRow = typeof packets.$inferSelect;
export type PacketInsert = typeof packets.$inferInsert;
