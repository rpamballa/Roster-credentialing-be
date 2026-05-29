import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { facilities, facilityProfiles } from "./facilities.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const INGEST_JOB_STATUSES = [
  "uploaded",
  "classifying",
  "parsing",
  "ready",
  "failed",
] as const;
export type IngestJobStatus = (typeof INGEST_JOB_STATUSES)[number];

// One row per specialist-uploaded facility packet. Drives the cockpit's
// ingest poller and the Temporal facility-ingest workflow.
export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "set null" }),
    uploadedDocUri: text("uploaded_doc_uri").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    specialtyHint: text("specialty_hint"),
    detectedSpecialty: text("detected_specialty"),
    status: text("status").notNull().default("uploaded"),
    facilityProfileId: uuid("facility_profile_id").references(() => facilityProfiles.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("ingest_jobs_workspace_idx").on(t.workspaceId, t.status),
    byFacility: index("ingest_jobs_facility_idx").on(t.facilityId),
  }),
);

export type IngestJobRow = typeof ingestJobs.$inferSelect;
export type IngestJobInsert = typeof ingestJobs.$inferInsert;
