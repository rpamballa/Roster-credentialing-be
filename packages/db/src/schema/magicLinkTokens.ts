import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Single-use, 7-day expiry magic link tokens (PROMPT M1 §5.3).
// We store only the SHA-256 hash of the token. The plaintext token is sent
// to the user once via email and never persisted.
export const magicLinkTokens = pgTable("magic_link_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  redirectPath: text("redirect_path"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  requestIp: text("request_ip"),
});

export type MagicLinkTokenRow = typeof magicLinkTokens.$inferSelect;
export type MagicLinkTokenInsert = typeof magicLinkTokens.$inferInsert;
