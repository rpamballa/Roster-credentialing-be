import { env } from "@cred/config";
import { logger } from "@cred/observability";

const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Cloudflare Turnstile token against Cloudflare's siteverify API.
 *
 * Returns:
 *   - { configured: false }                — TURNSTILE_SECRET_KEY unset; caller
 *                                            should skip Turnstile entirely
 *   - { configured: true, passed: true }   — token valid
 *   - { configured: true, passed: false }  — token missing or invalid; caller
 *                                            should reject 400
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<{ configured: false } | { configured: true; passed: boolean }> {
  const secret = env().TURNSTILE_SECRET_KEY;
  if (!secret) return { configured: false };

  if (!token) return { configured: true, passed: false };

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const resp = await fetch(ENDPOINT, { method: "POST", body });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "turnstile_verify_http_error");
      return { configured: true, passed: false };
    }
    const data = (await resp.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) {
      logger.info({ codes: data["error-codes"] }, "turnstile_verify_rejected");
    }
    return { configured: true, passed: Boolean(data.success) };
  } catch (err) {
    logger.warn({ err }, "turnstile_verify_threw");
    return { configured: true, passed: false };
  }
}
