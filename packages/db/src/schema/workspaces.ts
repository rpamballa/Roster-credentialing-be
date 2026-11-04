import type { WorkspaceSettings } from "@cred/types/domain";
import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaceTypeEnum } from "./enums.js";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: workspaceTypeEnum("type").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  emailInAddress: text("email_in_address").unique(),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default({}),
  billingStatus: text("billing_status").notNull().default("trial"),
  // At most one row may have isPlatformDefault = true (enforced by the
  // unique partial index `workspaces_only_one_platform_default`). This is
  // the fallback tenant that ensureProviderAccount uses when no
  // workspaceId is passed — the product rule that every provider lands in
  // at least one workspace. See migration 0019.
  isPlatformDefault: boolean("is_platform_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
