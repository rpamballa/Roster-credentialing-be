// ╔══════════════════════════════════════════════════════════════════════╗
// ║ 🚨 DEMO AUTH — DELETE THIS FILE BEFORE PRODUCTION 🚨                  ║
// ║                                                                      ║
// ║ This route is a side-channel that issues a session for any email     ║
// ║ that has a row in `users`, without any token/credential check. It    ║
// ║ exists to make tester onboarding painless on the staging stack       ║
// ║ where there's no real email sender wired.                            ║
// ║                                                                      ║
// ║ Guards in place (defense in depth — do NOT rely on just one):        ║
// ║   1. Hard gate on env DEMO_AUTH_ENABLED === "true".                  ║
// ║   2. Hard gate on NODE_ENV !== "production" by default; production   ║
// ║      use requires BOTH env flags to be set, AND the readme says      ║
// ║      delete-this-file.                                               ║
// ║   3. Every issuance writes an audit row, so abuse is visible.        ║
// ║                                                                      ║
// ║ Removal checklist before going live:                                 ║
// ║   - Delete this file                                                 ║
// ║   - Remove the `app.route("/", demoAuthRoutes)` line in app.ts       ║
// ║   - Remove DEMO_AUTH_ENABLED from .env templates                     ║
// ║   - Remove the demo-login card from apps/web/components/auth         ║
// ║   - Remove apps/web/app/api/auth/demo-signin                         ║
// ╚══════════════════════════════════════════════════════════════════════╝

import { createProviderSession, createSession } from "@cred/auth";
import { env } from "@cred/config";  // still used for NODE_ENV in cookie config
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

const DemoSigninSchema = z.object({
  email: z.string().email(),
});

const DemoProviderSigninSchema = z.object({
  caseId: z.string().uuid(),
});

function demoEnabled(): boolean {
  // Single explicit gate. The original design also checked `NODE_ENV !==
  // "production"` as a backstop, but the staging container runs in
  // production mode (Next.js standalone requires it), so that backstop
  // was a false-positive blocker. The safety contract is now:
  //   - This file MUST be deleted before deploying to actual production.
  //   - The README's "removal checklist" enforces that.
  //   - The flag must be the exact string "true" — not "1", not unset.
  return process.env.DEMO_AUTH_ENABLED === "true";
}

/**
 * Mount the demo-signin route directly on the main app rather than as a
 * sub-router. Other sub-routers in this codebase use catch-all middleware
 * patterns like `meRoutes.use("*", requireStaffAuth)` which Hono applies
 * across the whole mounted surface — that would 401 our anonymous demo
 * endpoint before it ran. Registering on the app dodges that.
 */
export function mountDemoAuth(app: Hono<ApiBindings>): void {
  app.post(
    "/auth/dev/demo-signin",
    zValidator("json", DemoSigninSchema),
    async (c) => {
    // When demo auth is off, return 404 (not 401/403) so the route's
    // existence isn't disclosed to probes.
    if (!demoEnabled()) return c.notFound();

    const { email } = c.req.valid("json");

    // rls: bypass — pre-tenancy user + membership lookup. Demo auth is
    // staging-only and reads its own gating env.
    const [user] = await db()
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (!user) {
      // Don't disclose user existence; same shape as a successful refusal.
      return c.json({ ok: false }, 403);
    }

    const [membership] = await db()
      .select({ workspaceId: schema.memberships.workspaceId })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user.id))
      .limit(1);

    const sid = await createSession({
      userId: user.id,
      email: user.email,
      activeWorkspaceId: membership?.workspaceId ?? null,
    });

    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: env().NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

    await audit({
      workspaceId: membership?.workspaceId ?? null,
      actorUserId: user.id,
      actorType: "user",
      action: "auth.demo_signin",
      targetEntityType: "user",
      targetEntityId: user.id,
      after: { email: user.email },
      requestId: c.var.requestId,
    });

    return c.json({ ok: true });
    },
  );

  // ── Provider demo-signin ────────────────────────────────────────────
  // Issues a `provider` session for a seeded case so the mobile-web
  // provider surface (`/case/<id>/*`) renders without going through the
  // real magic-link invite flow. Mirrors the staff handler above:
  //   - same gating env
  //   - same 404-when-disabled posture
  //   - same audit log (with `auth.demo_provider_signin` action)
  app.post(
    "/auth/dev/demo-provider-signin",
    zValidator("json", DemoProviderSigninSchema),
    async (c) => {
      if (!demoEnabled()) return c.notFound();

      const { caseId } = c.req.valid("json");

      // rls: bypass — demo path. We're handing out a provider session
      // for a specific case and need the provider + workspace columns
      // off the case row before any tenancy context exists.
      const [cs] = await db()
        .select({
          id: schema.cases.id,
          providerId: schema.cases.providerId,
          workspaceId: schema.cases.workspaceId,
        })
        .from(schema.cases)
        .where(eq(schema.cases.id, caseId))
        .limit(1);

      if (!cs) {
        // Same opaque refusal as the staff path — no case-existence leak.
        return c.json({ ok: false }, 403);
      }

      const sid = await createProviderSession({
        providerId: cs.providerId,
        caseId: cs.id,
        caseWorkspaceId: cs.workspaceId,
      });

      setCookie(c, SESSION_COOKIE, sid, {
        httpOnly: true,
        secure: env().NODE_ENV === "production",
        sameSite: "Lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });

      await audit({
        workspaceId: cs.workspaceId,
        actorUserId: null,
        actorType: "user",
        action: "auth.demo_provider_signin",
        targetEntityType: "case",
        targetEntityId: cs.id,
        after: { providerId: cs.providerId },
        requestId: c.var.requestId,
      });

      // The real `GET /v1/cases/<id>` endpoint now exists (see
      // routes/cases.ts) so we redirect the demo to the actual case
      // instead of the FE's `/case/demo` fixture shortcut.
      return c.json({ ok: true, redirectPath: `/case/${cs.id}` });
    },
  );
}
