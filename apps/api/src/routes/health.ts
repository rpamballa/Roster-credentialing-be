import { readFileSync } from "node:fs";
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

// Version metadata baked into the image at build time. The deploy
// workflow uses this endpoint to assert prod is on the sha it just
// pushed — closing the loop that used to be "trust me it deployed".
//
// `/app/version.txt` is written by deploy/Dockerfile.api's build
// stage from the GIT_SHA ARG. In dev (no build), the values fall
// back to "dev" so nothing crashes when running `pnpm dev`.
interface VersionInfo {
  sha: string;
  ref: string;
  builtAt: string;
}

const versionInfo: VersionInfo = readVersion();

function readVersion(): VersionInfo {
  try {
    const raw = readFileSync("/app/version.txt", "utf8").trim();
    const parts = Object.fromEntries(
      raw.split("\n").map((line) => {
        const idx = line.indexOf("=");
        return idx < 0 ? [line, ""] : [line.slice(0, idx), line.slice(idx + 1)];
      }),
    );
    return {
      sha: parts.sha ?? "unknown",
      ref: parts.ref ?? "unknown",
      builtAt: parts.builtAt ?? "unknown",
    };
  } catch {
    // Local dev, tests — no baked file. Return placeholders so
    // callers don't have to special-case "not deployed yet".
    return { sha: "dev", ref: "dev", builtAt: "dev" };
  }
}

healthRoutes.get("/version", (c) => c.json(versionInfo));
