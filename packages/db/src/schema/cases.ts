import type { Blocker } from "@cred/types/domain";
import { date, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { casePurposeEnum, caseStatusEnum } from "./enums.js";
import { providers } from "./providers.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    // facilityProfileId references facility_profiles (added in M3). For M2
    // we store the UUID without a FK so this table can land first.
    facilityProfileId: uuid("facility_profile_id"),
    facilityProfileVersion: text("facility_profile_version"),
    specialty: text("specialty").notNull(),
    purpose: casePurposeEnum("purpose").notNull(),
    status: caseStatusEnum("status").notNull().default("intake"),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    targetSubmissionDate: date("target_submission_date"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    assignedSpecialistId: uuid("assigned_specialist_id").references(() => users.id, {
      onDelete: "set null",
    }),
    blockers: jsonb("blockers").$type<Blocker[]>().notNull().default([]),
  },
  (t) => ({
    byWorkspaceStatus: index("cases_workspace_status_idx").on(t.workspaceId, t.status),
    byProvider: index("cases_provider_idx").on(t.providerId),
  }),
);

export type CaseRow = typeof cases.$inferSelect;
export type CaseInsert = typeof cases.$inferInsert;
