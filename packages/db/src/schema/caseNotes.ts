import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cases } from "./cases.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

// Specialist notes on a case. Soft-deleted so the audit trail retains
// what was written, but the FE hides deleted rows.
export const caseNotes = pgTable(
  "case_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    byCase: index("case_notes_case_created_idx").on(t.caseId, t.createdAt),
  }),
);

export type CaseNoteRow = typeof caseNotes.$inferSelect;
export type CaseNoteInsert = typeof caseNotes.$inferInsert;
