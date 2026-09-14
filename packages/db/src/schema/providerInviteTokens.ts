import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { providers } from "./providers.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * Workspace-scoped invite tokens for the beta onboarding flow.
 *
 * A cockpit admin invites a provider by email BEFORE any case exists —
 * a case_access_token can't carry that intent (it requires a case_id).
 * This table holds the pre-case invite: email + optional full name
 * captured at invite time, so the landing page can greet the provider
 * by first name if the admin knew it.
 *
 * Redemption creates (or reuses, keyed by email) a providers row and
 * writes provider_workspace_grants — the provider then shows up in
 * /cockpit/providers ready to have a case attached.
 *
 * Same crypto shape as case_access_tokens: 32 random bytes, only the
 * SHA-256 hash is persisted, single-use (redeemed_at set on redemption),
 * 7-day TTL enforced at query time.
 */
export const providerInviteTokens = pgTable(
  "provider_invite_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Full name as typed by the admin — split into first/last on redemption. */
    fullName: text("full_name"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    /** Populated on redemption — the providers row this invite resolved to. */
    providerId: uuid("provider_id").references(() => providers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("provider_invite_tokens_workspace_idx").on(t.workspaceId),
    byEmail: index("provider_invite_tokens_email_idx").on(t.workspaceId, t.email),
  }),
);

export type ProviderInviteTokenRow = typeof providerInviteTokens.$inferSelect;
export type ProviderInviteTokenInsert = typeof providerInviteTokens.$inferInsert;
