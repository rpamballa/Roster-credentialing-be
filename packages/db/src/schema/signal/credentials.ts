import { date, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";
import { signalProviders } from "./providers.js";

/**
 * License / cert / doc state per Signal provider.
 *
 * `earliest_start_projection` is the ranker's input signal — a jsonb
 * blob of `{ date, confidence, basis[] }` that explains WHY a given
 * earliest-start date was projected (the explainability source
 * referenced by `signal_rankings.entries[].reasons[]`).
 */
export const signalCredentials = pgTable(
  "signal_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => signalProviders.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    state: text("state"),
    issued: date("issued"),
    expires: date("expires"),
    status: text("status"),
    earliestStartProjection: jsonb("earliest_start_projection").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_credentials_workspace_idx").on(t.workspaceId),
    byProvider: index("signal_credentials_provider_idx").on(t.providerId),
    byWorkspaceType: index("signal_credentials_workspace_type_idx").on(t.workspaceId, t.type),
  }),
);

export type SignalCredentialRow = typeof signalCredentials.$inferSelect;
export type SignalCredentialInsert = typeof signalCredentials.$inferInsert;
