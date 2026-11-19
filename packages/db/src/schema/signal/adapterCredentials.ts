import { customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../workspaces.js";

/**
 * Drizzle doesn't ship a built-in bytea column, so we declare it via
 * `customType`. The JS side is `Buffer`, which `postgres-js` sends on
 * the wire as bytea.
 */
export const byteaColumn = customType<{
  data: Buffer;
  driverData: Buffer;
}>({
  dataType() {
    return "bytea";
  },
});

/**
 * Encrypted third-party API credentials per (workspace, adapter).
 *
 * `encrypted_payload` is ciphertext produced by
 * `packages/signal-knowledge/src/credentials.ts`:
 *
 *   • per-workspace key K = HKDF(SESSION_SECRET, salt = workspace_id,
 *     info = `signal/adapter/${adapter}`)
 *   • AES-256-GCM(K, iv, json(payload)) → [iv ‖ tag ‖ ciphertext]
 *
 * See the file header of that module for the threat model — the
 * encryption protects a DB dump, not an app-tier compromise.
 *
 * A PUT replaces the payload in place, bumps `payload_version` and
 * `rotated_at`. The unique `(workspace_id, adapter)` enforces one
 * row per adapter per workspace.
 *
 * NOTE: the plaintext NEVER appears in any HTTP response. Only the
 * in-process ingestion runner (inside the api container) decrypts
 * it via `decryptCredential`. The `GET /credentials/{adapter}`
 * route returns metadata only (`adapter`, `rotated_at`,
 * `payload_version`, `created_at`).
 */
export const signalAdapterCredentials = pgTable(
  "signal_adapter_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    adapter: text("adapter").notNull(),
    encryptedPayload: byteaColumn("encrypted_payload").notNull(),
    payloadVersion: integer("payload_version").notNull().default(1),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("signal_adapter_credentials_workspace_idx").on(t.workspaceId),
    uniqAdapterPerWorkspace: uniqueIndex("signal_adapter_credentials_workspace_adapter_uq").on(
      t.workspaceId,
      t.adapter,
    ),
  }),
);

export type SignalAdapterCredentialRow = typeof signalAdapterCredentials.$inferSelect;
export type SignalAdapterCredentialInsert = typeof signalAdapterCredentials.$inferInsert;
