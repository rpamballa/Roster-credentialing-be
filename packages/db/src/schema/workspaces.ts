import type { WorkspaceSettings } from "@cred/types/domain";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaceTypeEnum } from "./enums.js";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: workspaceTypeEnum("type").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  emailInAddress: text("email_in_address").unique(),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default({}),
  billingStatus: text("billing_status").notNull().default("trial"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
