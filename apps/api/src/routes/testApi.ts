// ────────────────────────────────────────────────────────────────────
// Test-only API endpoints.
//
// Mounted ONLY when the environment variable `TEST_API_ENABLED` is the
// literal string "true". `compose.test.yml` sets this; the production
// `compose.yml` does NOT. If someone slips the flag into a staging/
// prod env the handlers still refuse to run — they recheck the flag
// on every request. Mount-time + request-time double gate.
//
// Why this exists at all: Playwright specs need to seed state the real
// API doesn't expose (e.g. "set a known password for this user"). Doing
// it from the test runner via `docker exec … tsx -e …` broke on the
// Playwright test workers whose PATH no longer sees docker. A real
// HTTP endpoint is simpler, works from any runner, and gates cleanly
// on env.
// ────────────────────────────────────────────────────────────────────

import { hashPassword } from "@cred/auth";
import { db, schema } from "@cred/db";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiBindings } from "../types.js";

export const testApiRoutes = new Hono<ApiBindings>();

function refuseWhenDisabled(): Response | null {
  if (process.env.TEST_API_ENABLED !== "true") {
    return new Response("not found", { status: 404 });
  }
  return null;
}

const SeedPasswordBody = z.object({
  email: z.string().email(),
  plaintext: z.string().min(8).max(128),
});

/**
 * Hash `plaintext` with the same argon2 params as the real set-password
 * flow and persist it onto `users.password_hash`. Idempotent — safe to
 * call in beforeAll even when a prior run already set the password.
 *
 * Response:
 *   200 { ok: true, email } on success
 *   404                     when TEST_API_ENABLED is off (default)
 *   404 { title: ... }      when no user matches `email`
 */
testApiRoutes.post("/test/seed-password", zValidator("json", SeedPasswordBody), async (c) => {
  const refusal = refuseWhenDisabled();
  if (refusal) return refusal;
  const { email, plaintext } = c.req.valid("json");
  // rls: bypass — test setup owns the users table.
  const [user] = await db()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (!user) {
    return c.json({ type: "about:blank", title: `no user with email ${email}`, status: 404 }, 404);
  }
  const hash = await hashPassword(plaintext);
  // rls: bypass — direct password_hash write; the real flow goes through
  // the set-password route which also writes an audit row. For a test
  // helper we skip audit on purpose so the suite doesn't drown the
  // audit log in fixture rows.
  await db().update(schema.users).set({ passwordHash: hash }).where(eq(schema.users.id, user.id));
  return c.json({ ok: true, email });
});
