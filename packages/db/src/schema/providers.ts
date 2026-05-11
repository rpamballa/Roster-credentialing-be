import { date, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

// PROMPT §4.1: `providers` is intentionally NOT workspace-scoped. Access is
// gated through `provider_workspace_grants` so a single provider can be
// referenced by multiple agencies/hospitals — the network-effect foundation.
export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    npi: text("npi").unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    dob: date("dob"),
    ssnEncrypted: text("ssn_encrypted"),
    email: text("email"),
    phone: text("phone"),
    specialties: text("specialties").array().notNull().default([]),
    statesLicensed: text("states_licensed").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  },
  (t) => ({
    byEmail: index("providers_email_idx").on(t.email),
  }),
);

export const providerWorkspaceGrants = pgTable(
  "provider_workspace_grants",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.providerId, t.workspaceId] }),
    byWorkspace: index("provider_workspace_grants_workspace_idx").on(t.workspaceId),
  }),
);

export type ProviderRow = typeof providers.$inferSelect;
export type ProviderInsert = typeof providers.$inferInsert;
export type ProviderWorkspaceGrantRow = typeof providerWorkspaceGrants.$inferSelect;
export type ProviderWorkspaceGrantInsert = typeof providerWorkspaceGrants.$inferInsert;
