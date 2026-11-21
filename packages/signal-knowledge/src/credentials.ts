// Envelope-encrypted adapter credentials for Roster Signal.
//
// --------------------------------------------------------------------
// THREAT MODEL
// --------------------------------------------------------------------
// This module defends the ciphertext at rest. It is NOT a defense
// against an app-tier compromise.
//
//   Defended:
//     • Postgres dump / stolen backup — ciphertext is useless without
//       SESSION_SECRET (which lives in the deployment's env, not in
//       the DB).
//     • Read-only DB intruder (observation via replica, extension
//       bug, SELECT-only SQL injection).
//
//   Not defended:
//     • App-tier RCE or code-execution — the process holds
//       SESSION_SECRET in memory and can derive any workspace's key.
//     • Rogue operator — anyone who can run code in the API container
//       can decrypt any credential.
//
// A proper KMS (GCP KMS, HashiCorp Vault) would raise the second bar.
// We intentionally defer that: it adds deploy complexity for v0 and
// doesn't change the first-bar story. The payload_version column
// makes a future KMS migration straightforward (re-encrypt + bump).
//
// --------------------------------------------------------------------
// SCHEME
// --------------------------------------------------------------------
//   • Per-(workspace, adapter) key K:
//       salt = utf8(workspace_id)                  // 36 bytes
//       info = utf8(`signal/adapter/${adapter}`)
//       K    = HKDF-SHA-256(SESSION_SECRET, salt, info, 32)
//     ⇒ different workspace or adapter ⇒ different K; decrypt on the
//     wrong (workspace, adapter) pair fails on the GCM tag check.
//
//   • Record layout (bytes):
//       [12 | 16 |  N ]
//       [ iv | tag | ct]
//     — iv is a random 96-bit nonce (new per encrypt), tag is the
//     GCM auth tag, ct is the ciphertext. Prepending the IV + tag
//     keeps `decrypt(encrypt(x)) == x` as a pure function of the
//     stored bytes plus the key.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@cred/config";

const AES_KEY_LEN = 32; // bytes — AES-256
const GCM_IV_LEN = 12; // bytes — 96-bit nonce
const GCM_TAG_LEN = 16; // bytes — 128-bit auth tag

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertWorkspace(workspaceId: string): void {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error(`credentials: workspaceId is not a valid UUID (${workspaceId})`);
  }
}

function assertAdapter(adapter: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,62}$/.test(adapter)) {
    throw new Error(`credentials: adapter must match ^[a-z][a-z0-9_.-]{0,62}$ (${adapter})`);
  }
}

function deriveKey(workspaceId: string, adapter: string): Buffer {
  const secret = env().SESSION_SECRET;
  // hkdfSync returns ArrayBuffer; wrap it as a Buffer for crypto APIs.
  const salt = Buffer.from(workspaceId, "utf8");
  const info = Buffer.from(`signal/adapter/${adapter}`, "utf8");
  const key = hkdfSync("sha256", secret, salt, info, AES_KEY_LEN);
  return Buffer.from(key);
}

/**
 * Envelope-encrypt a credential payload. Returns the opaque bytes to
 * store in `signal_adapter_credentials.encrypted_payload`.
 */
export function encryptCredential(
  workspaceId: string,
  adapter: string,
  payload: unknown,
): Buffer {
  assertWorkspace(workspaceId);
  assertAdapter(adapter);

  const key = deriveKey(workspaceId, adapter);
  const iv = randomBytes(GCM_IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/**
 * Decrypt a credential payload. Throws if the ciphertext is
 * malformed, if the tag fails, or if the (workspaceId, adapter) pair
 * does not match the one used to encrypt.
 */
export function decryptCredential(
  workspaceId: string,
  adapter: string,
  encrypted: Buffer,
): unknown {
  assertWorkspace(workspaceId);
  assertAdapter(adapter);
  if (encrypted.length < GCM_IV_LEN + GCM_TAG_LEN) {
    throw new Error("credentials: ciphertext shorter than header");
  }

  const iv = encrypted.subarray(0, GCM_IV_LEN);
  const tag = encrypted.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN);
  const ct = encrypted.subarray(GCM_IV_LEN + GCM_TAG_LEN);

  const key = deriveKey(workspaceId, adapter);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}
