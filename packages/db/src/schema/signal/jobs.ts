import { date, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { facilities } from "../facilities.js";
import { workspaces } from "../workspaces.js";

/**
 * Open requisitions. `facility_id` points at the existing
 * `facilities` table — intentionally global (not workspace-scoped),
 * matching the credentialing convention. Signal's tenant boundary
 * sits on `workspace_id` here.
 */
export const signalJobs = pgTable(
  "signal_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    facilityId: uuid("facility_id").references(() => facilities.id, { onDelete: "set null" }),
    specialty: text("specialty").notNull(),
    needDate: date("need_date"),
    region: text("region"),
    pay: numeric("pay", { precision: 12, scale: 2 }),
    state: text("state"),
    reqOpenedAt: timestamp("req_opened_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_jobs_workspace_idx").on(t.workspaceId),
    byWorkspaceNeedDate: index("signal_jobs_workspace_need_date_idx").on(t.workspaceId, t.needDate),
    byFacility: index("signal_jobs_facility_idx").on(t.facilityId),
  }),
);

export type SignalJobRow = typeof signalJobs.$inferSelect;
export type SignalJobInsert = typeof signalJobs.$inferInsert;
