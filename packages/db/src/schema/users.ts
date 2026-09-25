import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  // Argon2id hash from `packages/auth/src/password.ts`. Null when the
  // account was minted before password auth shipped or when the user
  // came in via magic-link only. login refuses null-hash accounts with
  // "no password set — use magic-link"; a follow-up in-cockpit banner
  // prompts these users to set one.
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
