import { db } from "@cred/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { ApiBindings } from "../types.js";

export const healthRoutes = new Hono<ApiBindings>();

healthRoutes.get("/health", (c) => c.json({ status: "ok" }));

healthRoutes.get("/health/ready", async (c) => {
  // rls: bypass — readiness probe; no tenant data.
  try {
    await db().execute(sql`SELECT 1`);
    return c.json({ status: "ready" });
  } catch (err) {
    return c.json({ status: "not_ready", reason: (err as Error).message }, 503);
  }
});
