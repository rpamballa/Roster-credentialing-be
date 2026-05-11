import type { FacilityRequirements } from "@cred/types";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

// Facilities are global rather than workspace-scoped (a single hospital may
// be referenced by many agencies). Access to facilities is implicit — they
// hold no PHI and the requirements profiles below carry the workspace
// boundary.
export const facilities = pgTable("facilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  address: text("address"),
  ein: text("ein"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const facilityProfiles = pgTable(
  "facility_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    sourcePacketUri: text("source_packet_uri"),
    sourceEmailId: uuid("source_email_id"),
    requirements: jsonb("requirements").$type<FacilityRequirements>().notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byFacilityWorkspace: index("facility_profiles_facility_workspace_idx").on(
      t.facilityId,
      t.workspaceId,
      t.version,
    ),
    byWorkspaceStatus: index("facility_profiles_workspace_status_idx").on(t.workspaceId, t.status),
  }),
);

// Immutable history of approved versions for audit/lineage.
export const facilityProfileVersions = pgTable(
  "facility_profile_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    facilityProfileId: uuid("facility_profile_id")
      .notNull()
      .references(() => facilityProfiles.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    requirements: jsonb("requirements").$type<FacilityRequirements>().notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    byProfile: index("facility_profile_versions_profile_idx").on(t.facilityProfileId, t.version),
  }),
);

// Captures every specialist correction so we can fine-tune later.
export const trainingCorrections = pgTable(
  "training_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    facilityProfileId: uuid("facility_profile_id").references(() => facilityProfiles.id, {
      onDelete: "set null",
    }),
    documentId: uuid("document_id"),
    fieldPath: text("field_path").notNull(),
    before: jsonb("before"),
    after: jsonb("after").notNull(),
    correctedBy: uuid("corrected_by").references(() => users.id, { onDelete: "set null" }),
    correctedAt: timestamp("corrected_at", { withTimezone: true }).defaultNow().notNull(),
    sourceTask: text("source_task"),
  },
  (t) => ({
    byWorkspace: index("training_corrections_workspace_idx").on(t.workspaceId, t.correctedAt),
    byProfile: index("training_corrections_profile_idx").on(t.facilityProfileId),
  }),
);

// Inbound emails received by Resend webhooks. Stored raw + attachments live
// in object storage; this row is the index.
export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    recipient: text("recipient").notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject"),
    rawPayloadUri: text("raw_payload_uri").notNull(),
    attachmentKeys: jsonb("attachment_keys").$type<string[]>().notNull().default([]),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    parseStatus: text("parse_status").notNull().default("received"),
  },
  (t) => ({
    byRecipient: index("inbound_emails_recipient_idx").on(t.recipient, t.receivedAt),
    byWorkspace: index("inbound_emails_workspace_idx").on(t.workspaceId, t.receivedAt),
  }),
);

export type FacilityRow = typeof facilities.$inferSelect;
export type FacilityInsert = typeof facilities.$inferInsert;
export type FacilityProfileRow = typeof facilityProfiles.$inferSelect;
export type FacilityProfileInsert = typeof facilityProfiles.$inferInsert;
export type FacilityProfileVersionRow = typeof facilityProfileVersions.$inferSelect;
export type FacilityProfileVersionInsert = typeof facilityProfileVersions.$inferInsert;
export type TrainingCorrectionRow = typeof trainingCorrections.$inferSelect;
export type TrainingCorrectionInsert = typeof trainingCorrections.$inferInsert;
export type InboundEmailRow = typeof inboundEmails.$inferSelect;
export type InboundEmailInsert = typeof inboundEmails.$inferInsert;
