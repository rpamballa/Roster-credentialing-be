import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { providers } from "./providers.js";
import { workspaces } from "./workspaces.js";

// Primary source verifications keyed by (provider, type, source). We keep
// one row per attempt; the latest row per (provider, type) is the active
// state. Re-verification cadence (default 90 days) is enforced by the
// verification workflow, not the schema.
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    source: text("source").notNull(),
    state: text("state"),
    licenseNumber: text("license_number"),
    status: text("status").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    error: text("error"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    nextVerifyAt: timestamp("next_verify_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byProvider: index("verifications_provider_idx").on(t.providerId, t.type),
    byNext: index("verifications_next_verify_idx").on(t.nextVerifyAt),
  }),
);

export type VerificationRow = typeof verifications.$inferSelect;
export type VerificationInsert = typeof verifications.$inferInsert;
