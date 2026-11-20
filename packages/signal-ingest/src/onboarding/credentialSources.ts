/**
 * Resolve a `CredentialSource` descriptor into the actual
 * `Record<string, string>` the adapter expects.
 *
 * Kept separate from `config.ts` so the schema stays declarative and
 * zero-dep. The runner is the only caller; this module has no
 * knowledge of the DB layer or of encryption.
 */

import { readFileSync } from "node:fs";
import type { CredentialSource } from "./config.js";

export class CredentialResolutionError extends Error {
  readonly adapter: string;
  readonly source: CredentialSource["source"];
  constructor(adapter: string, source: CredentialSource["source"], detail: string) {
    super(`credentials for '${adapter}' (${source}): ${detail}`);
    this.name = "CredentialResolutionError";
    this.adapter = adapter;
    this.source = source;
  }
}

export interface ResolveOptions {
  /**
   * When true, allow `source: "inline"` even if NODE_ENV is set to
   * "production". Default false — inline-in-prod is treated as an
   * error so a leaked config file can't silently ship secrets.
   */
  allowInlineInProd?: boolean;
}

/**
 * Read a credential bag from the configured source. Returns a flat
 * object the adapter will JSON-stringify + encrypt with
 * `encryptCredential(workspaceId, adapter, payload)`.
 */
export function resolveCredentials(
  adapter: string,
  source: CredentialSource,
  opts: ResolveOptions = {},
): Record<string, string> {
  switch (source.source) {
    case "env":
      return resolveEnv(adapter, source.map);
    case "inline":
      return resolveInline(adapter, source.values, opts.allowInlineInProd ?? false);
    case "file":
      return resolveFile(adapter, source.path);
    default: {
      const unreachable: never = source;
      throw new Error(`unhandled credential source: ${JSON.stringify(unreachable)}`);
    }
  }
}

function resolveEnv(adapter: string, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [credKey, envVar] of Object.entries(map)) {
    const v = process.env[envVar];
    if (v === undefined || v === "") {
      missing.push(`${credKey} <- $${envVar}`);
      continue;
    }
    out[credKey] = v;
  }
  if (missing.length > 0) {
    throw new CredentialResolutionError(
      adapter,
      "env",
      `missing environment variables: ${missing.join(", ")}`,
    );
  }
  return out;
}

function resolveInline(
  adapter: string,
  values: Record<string, string>,
  allowInProd: boolean,
): Record<string, string> {
  if (process.env.NODE_ENV === "production" && !allowInProd) {
    throw new CredentialResolutionError(
      adapter,
      "inline",
      "inline credentials refused in NODE_ENV=production (pass --allow-inline-in-prod to override)",
    );
  }
  return { ...values };
}

function resolveFile(adapter: string, path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CredentialResolutionError(adapter, "file", `read failed: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CredentialResolutionError(adapter, "file", `not valid JSON: ${detail}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialResolutionError(
      adapter,
      "file",
      "expected a JSON object of {key: stringValue}",
    );
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new CredentialResolutionError(
        adapter,
        "file",
        `value for '${k}' must be a string (got ${typeof v})`,
      );
    }
    out[k] = v;
  }
  return out;
}
