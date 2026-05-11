// Lightweight token-bucket rate limiter backed by Redis. Used on auth and
// webhook endpoints to bound abuse. Tenant-scoped routes are bounded by
// session validity + RLS; we don't rate-limit those by default.
import { env } from "@cred/config";
import { logger } from "@cred/observability";
import type { Context, MiddlewareHandler } from "hono";
import { Redis } from "ioredis";
import type { ApiBindings } from "../types.js";

let redis: Redis | undefined;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return redis;
}

export interface RateLimitOptions {
  scope: string;
  windowSeconds: number;
  max: number;
  keyFn?: (c: Context<ApiBindings>) => string;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<ApiBindings> {
  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const subject = options.keyFn ? options.keyFn(c) : ip;
    const key = `rl:${options.scope}:${subject}`;
    try {
      const count = await getRedis().incr(key);
      if (count === 1) await getRedis().expire(key, options.windowSeconds);
      if (count > options.max) {
        return c.json(
          {
            type: "https://errors.cred/rate-limit",
            title: "Too Many Requests",
            status: 429,
            instance: c.var.requestId,
          },
          429,
        );
      }
    } catch (err) {
      // Fail-open if Redis is unreachable — log and move on.
      logger.warn({ err, scope: options.scope }, "rate_limit_failed");
    }
    await next();
  };
}
