import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";

/**
 * Signal's canonical provider row.
 *
 * Separate from the credentialing `providers` table (which is
 * cross-tenant via `provider_workspace_grants`) because Signal needs
 * to do aggressive entity resolution, merges, and workspace-local
 * re-shaping without touching the row that powers active
 * credentialing cases. Lineage back to the upstream system — incl.
 * the credentialing `providers` row — lives in
 * `signal_source_lineage`.
 *
 * `email` / `phone` are stored here (beyond the WS B minimum set) so
 * entity resolution can match a touched provider by any of
 * (npi, email, phone) without a side table. See
 * `packages/db/src/signal/resolve.ts`.
 *
 * `merged_from` is a text[] of JSON-encoded snapshots of providers
 * that were merged INTO this row — enough information to reverse
 * the merge later. See `mergeProviders` / `unmergeLastProvider`.
 */
export const signalProviders = pgTable(
  "signal_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    npi: text("npi"),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    specialties: jsonb("specialties").$type<string[]>().notNull().default([]),
    regionPrefs: jsonb("region_prefs").$type<string[]>().notNull().default([]),
    rateBand: text("rate_band"),
    availabilityHint: jsonb("availability_hint").$type<Record<string, unknown>>(),
    mergedFrom: text("merged_from").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_providers_workspace_idx").on(t.workspaceId),
    uniqWorkspaceNpi: uniqueIndex("signal_providers_workspace_npi_uq")
      .on(t.workspaceId, t.npi)
      .where(sql`${t.npi} IS NOT NULL`),
    byWorkspaceEmail: index("signal_providers_workspace_email_idx")
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL`),
    byWorkspacePhone: index("signal_providers_workspace_phone_idx")
      .on(t.workspaceId, t.phone)
      .where(sql`${t.phone} IS NOT NULL`),
  }),
);

export type SignalProviderRow = typeof signalProviders.$inferSelect;
export type SignalProviderInsert = typeof signalProviders.$inferInsert;
