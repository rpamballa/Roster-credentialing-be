import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Public marketing leads — beta applications and demo requests submitted from
 * the public marketing surface. Pre-tenancy data; no RLS. See
 * migrations/0008_marketing_leads.sql for the SQL definition.
 */
export const marketingLeads = pgTable(
  "marketing_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "beta" | "demo" — DB-side CHECK constraint enforces. */
    kind: text("kind").notNull(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    agency: text("agency").notNull(),
    role: text("role"),
    /** Beta-only: placement-volume bucket. */
    volume: text("volume"),
    /** Free-text: "how does your team handle this today" / "what would you want to see". */
    freeText: text("free_text"),
    sourcePath: text("source_path"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    turnstilePassed: boolean("turnstile_passed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index("marketing_leads_created_at_idx").on(t.createdAt),
    kindIdx: index("marketing_leads_kind_idx").on(t.kind, t.createdAt),
    ipIdx: index("marketing_leads_ip_idx").on(t.ip, t.createdAt),
  }),
);

export type MarketingLeadRow = typeof marketingLeads.$inferSelect;
export type MarketingLeadInsert = typeof marketingLeads.$inferInsert;
