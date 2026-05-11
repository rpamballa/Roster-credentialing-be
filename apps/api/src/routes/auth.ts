import {
  MagicLinkInvalidError,
  consumeMagicLink,
  createSession,
  destroySession,
  issueMagicLink,
  updateSession,
} from "@cred/auth";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { MagicLinkRequestSchema, MagicLinkVerifySchema } from "@cred/types";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
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
