import {
  MagicLinkInvalidError,
  consumeMagicLink,
  createSession,
  destroySession,
  issueMagicLink,
  updateSession,
  verifyPassword,
} from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { MagicLinkRequestSchema, MagicLinkVerifySchema } from "@cred/types";
import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "../middleware/session.js";
import type { ApiBindings } from "../types.js";

export const authRoutes = new Hono<ApiBindings>();

authRoutes.post(
  "/auth/magic-link/request",
  zValidator("json", MagicLinkRequestSchema),
  async (c) => {
    const { email, redirectPath } = c.req.valid("json");
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    await issueMagicLink({
      email,
      requestIp: ip,
      ...(redirectPath !== undefined ? { redirectPath } : {}),
    });
    return c.json({ ok: true });
  },
);

authRoutes.post("/auth/magic-link/verify", zValidator("json", MagicLinkVerifySchema), async (c) => {
  const { token } = c.req.valid("json");
  try {
    const consumed = await consumeMagicLink(token);

    // rls: bypass — pre-tenancy workspace lookup for the user.
    const membership = await db()
      .select({ workspaceId: schema.memberships.workspaceId })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, consumed.userId))
      .limit(1);

    const sid = await createSession({
      userId: consumed.userId,
      email: consumed.email,
      activeWorkspaceId: membership[0]?.workspaceId ?? null,
    });

    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: env().NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

    return c.json({
      ok: true,
      isNewUser: consumed.isNewUser,
      redirectPath: consumed.redirectPath,
    });
  } catch (err) {
    if (err instanceof MagicLinkInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/auth/invalid-token",
          title: "Invalid or expired token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }
});

authRoutes.post("/auth/logout", async (c) => {
  const auth = c.var.auth;
  if (auth) {
    await destroySession(auth.sid);
    if (auth.session.kind === "staff") {
      await audit({
        workspaceId: auth.session.activeWorkspaceId,
        actorUserId: auth.session.userId,
        actorType: "user",
        action: "auth.logout",
        targetEntityType: "user",
        targetEntityId: auth.session.userId,
        requestId: c.var.requestId,
      });
    } else {
      await audit({
        workspaceId: auth.session.caseWorkspaceId,
        actorUserId: null,
        actorType: "agent",
        action: "auth.logout",
        targetEntityType: "case",
        targetEntityId: auth.session.caseId,
        requestId: c.var.requestId,
      });
    }
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.post("/auth/workspace/switch", async (c) => {
  const auth = c.var.auth;
  if (!auth || auth.session.kind !== "staff") {
    return c.json(
      { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
      401,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const workspaceId = body?.workspaceId;
  if (typeof workspaceId !== "string") {
    return c.json({ type: "about:blank", title: "workspaceId is required", status: 400 }, 400);
  }

  // rls: bypass — verifying membership before switching active workspace.
  const rows = await db()
    .select({ id: schema.memberships.workspaceId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, auth.session.userId));

  if (!rows.some((r) => r.id === workspaceId)) {
    return c.json(
      { type: "about:blank", title: "Forbidden", status: 403, instance: c.var.requestId },
      403,
    );
  }

  await updateSession(auth.sid, { activeWorkspaceId: workspaceId });
  return c.json({ ok: true, activeWorkspaceId: workspaceId });
});

// ─── POST /auth/password/login ──────────────────────────────────────
// Email + password → session cookie. Used by the new /signin form.
//
// Timing:
//   • Both "user not found" and "hash null" paths run a dummy argon2
//     verify against a fixed hash so the response timing doesn't leak
//     whether the email exists.
//   • The rate limiter mounted in app.ts (10 attempts / minute / IP)
//     is the outer brute-force gate.
//
// Response contract:
//   • Success → 200 { ok: true }, Set-Cookie: cred_sid
//   • Any failure (unknown email, no password set, wrong password) →
//     401 { title: "Incorrect email or password" } — a single opaque
//     error so account enumeration doesn't leak. The "no password set"
//     case surfaces separately in the FE via a follow-up magic-link
//     nudge (that's the FE's job, not ours).
const PasswordLoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(256),
});

/**
 * A deterministic hash of "" used only for constant-time dummy verifies
 * on the "user not found" / "no password set" branches. Never a valid
 * login target (the empty string can't satisfy the policy).
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$m5c5NmB8H3v8x8vJ7q2h1r+6yF3xEuJUu4mE5rQ1O0k";

authRoutes.post("/auth/password/login", zValidator("json", PasswordLoginBody), async (c) => {
  const { email, password } = c.req.valid("json");

  // rls: bypass — pre-tenancy user lookup.
  const [user] = await db()
    .select({
      id: schema.users.id,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
    })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email))
    .limit(1);

  const hash = user?.passwordHash ?? DUMMY_HASH;
  const passwordOk = await verifyPassword(password, hash);

  if (!user || !user.passwordHash || !passwordOk) {
    logger.info(
      { email, hasUser: Boolean(user), hasHash: Boolean(user?.passwordHash) },
      "password_login_rejected",
    );
    return c.json(
      {
        type: "https://errors.cred/auth/invalid-credentials",
        title: "Incorrect email or password",
        status: 401,
        instance: c.var.requestId,
      },
      401,
    );
  }

  // rls: bypass — pre-tenancy workspace lookup for the user.
  const membership = await db()
    .select({ workspaceId: schema.memberships.workspaceId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user.id))
    .limit(1);

  const sid = await createSession({
    userId: user.id,
    email: user.email,
    activeWorkspaceId: membership[0]?.workspaceId ?? null,
  });

  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  await audit({
    workspaceId: membership[0]?.workspaceId ?? null,
    actorUserId: user.id,
    actorType: "user",
    action: "auth.password_login",
    targetEntityType: "user",
    targetEntityId: user.id,
    requestId: c.var.requestId,
  });

  return c.json({ ok: true });
});
