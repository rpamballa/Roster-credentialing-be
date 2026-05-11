import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cases } from "./cases.js";
import { providers } from "./providers.js";

// Case-scoped access tokens for the provider experience (SPEC §1).
// The provider receives the plaintext token via SMS or email (PROMPT M2 §6);
// only the SHA-256 hash is persisted. Tokens are reusable until they expire,
// and can be revoked by writing revoked_at.
export const caseAccessTokens = pgTable(
  "case_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    byCase: index("case_access_tokens_case_idx").on(t.caseId),
    byProvider: index("case_access_tokens_provider_idx").on(t.providerId),
  }),
);

export type CaseAccessTokenRow = typeof caseAccessTokens.$inferSelect;
export type CaseAccessTokenInsert = typeof caseAccessTokens.$inferInsert;
