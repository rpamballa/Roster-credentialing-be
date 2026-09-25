import {
  MagicLinkInvalidError,
  ProviderInviteInvalidError,
  attachProviderToInvite,
  consumeMagicLink,
  createSession,
  destroySession,
  hashPassword,
  hashProviderInviteToken,
  issueMagicLink,
  passwordSchema,
  previewProviderInviteToken,
  redeemProviderInviteToken,
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

// ─── POST /auth/password/set ────────────────────────────────────────
// Terminal step of the invite flow — the provider (or workspace-invitee
// staff) lands on /invite/[token], sees a "Set your password" form, and
// posts the token + chosen password here.
//
// Effects, all in a single request (idempotency where safe, atomicity
// where it matters):
//   1. Look the token up in provider_invite_tokens (workspace scope).
//      A future extension can branch on case_access_tokens too.
//   2. Hash the password with argon2id — same policy the FE enforced.
//   3. Upsert users row keyed on lower(email). Set password_hash.
//   4. Upsert providers row keyed on email; link user_id.
//   5. Grant provider ↔ workspace via provider_workspace_grants.
//   6. Consume the invite token (single-atomic UPDATE, so a
//      double-submit collapses to one).
//   7. Mint a staff session pointing at the granting workspace.
//   8. Emit invite.redeemed + auth.password_set audit events.
//
// Rate-limited under /auth/password/* (10/min/IP). Same opaque error
// surface as login for the "bad token" path.
const PasswordSetBody = z.object({
  token: z.string().min(16).max(512),
  password: passwordSchema,
});

authRoutes.post("/auth/password/set", zValidator("json", PasswordSetBody), async (c) => {
  const { token, password } = c.req.valid("json");

  // Peek before we commit — invalid tokens surface a 400 before any
  // side effects run, and we don't need to swallow a password hash for
  // a token that was already consumed.
  let preview: Awaited<ReturnType<typeof previewProviderInviteToken>>;
  try {
    preview = await previewProviderInviteToken(token);
  } catch (err) {
    if (err instanceof ProviderInviteInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/auth/invalid-invite",
          title: "Invalid or expired invite",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }

  const hashed = await hashPassword(password);
  const email = preview.email;
  const displayName = preview.fullName;

  // rls: bypass — users is workspace-independent; we're pre-tenancy.
  // Upsert by lower(email) so a re-redeem for the same user is a
  // rotate-password rather than an insert conflict.
  const [userRow] = await db()
    .insert(schema.users)
    .values({
      email,
      name: displayName,
      passwordHash: hashed,
      emailVerifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { passwordHash: hashed, emailVerifiedAt: new Date() },
    })
    .returning({ id: schema.users.id });
  if (!userRow) throw new Error("failed to upsert user on password set");

  // Consume the token (single-atomic UPDATE). If a concurrent redeem
  // stole it between the preview and now, bail cleanly.
  let redeemed: Awaited<ReturnType<typeof redeemProviderInviteToken>>;
  try {
    redeemed = await redeemProviderInviteToken(token);
  } catch (err) {
    if (err instanceof ProviderInviteInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/auth/invalid-invite",
          title: "Invalid or expired invite",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }

  const { firstName, lastName } = splitFullName(redeemed.fullName);

  // rls: bypass — providers is workspace-independent (§4.1). Upsert on
  // email so a provider spanning multiple agencies stays one row.
  let providerId: string;
  const [existingProvider] = await db()
    .select({ id: schema.providers.id, userId: schema.providers.userId })
    .from(schema.providers)
    .where(eq(schema.providers.email, redeemed.email))
    .limit(1);
  if (existingProvider) {
    providerId = existingProvider.id;
    if (existingProvider.userId !== userRow.id) {
      await db()
        .update(schema.providers)
        .set({ userId: userRow.id, updatedAt: new Date() })
        .where(eq(schema.providers.id, providerId));
    }
  } else {
    const [inserted] = await db()
      .insert(schema.providers)
      .values({
        email: redeemed.email,
        firstName,
        lastName,
        userId: userRow.id,
      })
      .returning({ id: schema.providers.id });
    if (!inserted) throw new Error("failed to create provider on password set");
    providerId = inserted.id;
  }

  // rls: bypass — grants table is the workspace-access check.
  await db()
    .insert(schema.providerWorkspaceGrants)
    .values({
      providerId,
      workspaceId: redeemed.workspaceId,
      grantedBy: null,
    })
    .onConflictDoNothing();

  await attachProviderToInvite(hashProviderInviteToken(token), providerId);

  const sid = await createSession({
    userId: userRow.id,
    email,
    activeWorkspaceId: redeemed.workspaceId,
  });

  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  await audit({
    workspaceId: redeemed.workspaceId,
    actorUserId: userRow.id,
    actorType: "user",
    action: "auth.password_set",
    targetEntityType: "user",
    targetEntityId: userRow.id,
    after: { providerId },
    requestId: c.var.requestId,
  });

  await audit({
    workspaceId: redeemed.workspaceId,
    actorUserId: userRow.id,
    actorType: "user",
    action: "provider_invite.redeemed",
    targetEntityType: "provider",
    targetEntityId: providerId,
    after: { email, source: "password_set" },
    requestId: c.var.requestId,
  });

  return c.json({
    ok: true,
    userId: userRow.id,
    providerId,
    workspaceId: redeemed.workspaceId,
  });
});

function splitFullName(full: string | null): { firstName: string; lastName: string } {
  const trimmed = (full ?? "").trim();
  if (!trimmed) return { firstName: "Provider", lastName: "" };
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? "Provider";
  const last = parts.slice(1).join(" ");
  return { firstName: first, lastName: last };
}
