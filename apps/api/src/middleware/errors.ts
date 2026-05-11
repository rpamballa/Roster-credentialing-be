import { env } from "@cred/config";
import { logger } from "@cred/observability";
import type { ProblemDetails } from "@cred/types";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { ApiBindings } from "../types.js";

// SPEC §5.6 — all error responses are RFC 7807 Problem Details with no PHI
// and no stack traces in production.
export function onError(err: Error, c: Context<ApiBindings>): Response {
  const requestId = c.var.requestId ?? "unknown";
  const cfg = env();

  if (err instanceof HTTPException) {
    const status = err.status;
    const problem: ProblemDetails = {
      type: "about:blank",
      title: err.message || statusTitle(status),
      status,
      instance: requestId,
    };
    return c.json(problem, status);
  }

  if (err instanceof ZodError) {
    logger.warn({ requestId, issues: err.issues }, "validation_error");
    const problem: ProblemDetails = {
      type: "https://errors.cred/validation",
      title: "Invalid request",
      status: 400,
      instance: requestId,
      errors: err.issues.map((i) => ({ path: i.path, message: i.message })),
    };
    return c.json(problem, 400);
  }

  logger.error({ requestId, err: { name: err.name, message: err.message } }, "unhandled_error");

  const problem: ProblemDetails = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    instance: requestId,
    ...(cfg.NODE_ENV !== "production" ? { detail: err.message } : {}),
  };
  return c.json(problem, 500);
}

function statusTitle(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Unprocessable Entity";
  if (status === 429) return "Too Many Requests";
  return "Error";
}
