import { type ProviderSessionPayload, type StaffSessionPayload, readSession } from "@cred/auth";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ApiBindings } from "../types.js";

export const SESSION_COOKIE = "cred_sid";

/** Populate c.var.auth if a valid session cookie is present. Does not gate. */
export const sessionLoader: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const session = await readSession(sid);
    if (session) c.set("auth", { sid, session });
  }
  await next();
};

function unauthorized(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Unauthorized", status: 401, instance: c.var.requestId },
    401,
  );
}

/** Gate: any authenticated session. */
export const requireAuth: MiddlewareHandler<ApiBindings> = async (c, next) => {
  if (!c.var.auth) return unauthorized(c);
  await next();
};

/** Gate: staff session only. Narrows c.var.staffAuth for downstream handlers. */
export const requireStaffAuth: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const auth = c.var.auth;
  if (!auth || auth.session.kind !== "staff") return unauthorized(c);
  c.set("staffAuth", { sid: auth.sid, session: auth.session });
  await next();
};

/** Gate: provider session only. Narrows c.var.providerAuth for downstream. */
export const requireProviderAuth: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const auth = c.var.auth;
  if (!auth || auth.session.kind !== "provider") return unauthorized(c);
  c.set("providerAuth", { sid: auth.sid, session: auth.session });
  await next();
};

declare module "hono" {
  interface ContextVariableMap {
    staffAuth: { sid: string; session: StaffSessionPayload };
    providerAuth: { sid: string; session: ProviderSessionPayload };
  }
}
