import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cases } from "./cases.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const caseStatusEvents = pgTable(
  "case_status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("user"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCase: index("case_status_events_case_created_idx").on(t.caseId, t.createdAt),
  }),
);

export type CaseStatusEventRow = typeof caseStatusEvents.$inferSelect;
export type CaseStatusEventInsert = typeof caseStatusEvents.$inferInsert;
