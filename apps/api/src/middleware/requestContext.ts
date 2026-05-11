import { randomUUID } from "node:crypto";
import { logger } from "@cred/observability";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings } from "../types.js";

export const requestContext: MiddlewareHandler<ApiBindings> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const requestId = incoming && /^[a-zA-Z0-9-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  const start = Date.now();
  await next();
  logger.info(
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
    },
    "http_request",
  );
};
