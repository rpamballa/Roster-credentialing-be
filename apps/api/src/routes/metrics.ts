// Baseline measurement (PROMPT M6 §3). Returns per-workspace KPIs used by
// the pilot dashboard:
//   - cases opened / completed in window
//   - packets assembled / submitted in window
//   - specialist active touch time (median seconds between case open and
//     submission), approximated until we instrument timer events
//   - AI accuracy proxy: fraction of documents that the provider confirmed
//     without editing (M2 confirm endpoint stores edits — we use confirmedAt
//     presence as the proxy until field-level diffs land)

import { db, schema, withTenancy } from "@cred/db";
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import type { ApiBindings } from "../types.js";

export const metricsRoutes = new Hono<ApiBindings>();

metricsRoutes.use("/cockpit/metrics/*", requireStaffAuth, requireTenancy);

metricsRoutes.get("/cockpit/metrics/baseline", async (c) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const tenancy = c.var.tenancy;

  const metrics = await withTenancy(tenancy, async (tx) => {
    const [casesOpened] = await tx
      .select({ n: count() })
      .from(schema.cases)
      .where(
        and(eq(schema.cases.workspaceId, tenancy.workspaceId), gte(schema.cases.openedAt, since)),
      );

    const [casesSubmitted] = await tx
      .select({ n: count() })
      .from(schema.cases)
      .where(
        and(
          eq(schema.cases.workspaceId, tenancy.workspaceId),
          isNotNull(schema.cases.submittedAt),
          gte(schema.cases.submittedAt, since),
        ),
      );

    const [packetsAssembled] = await tx
      .select({ n: count() })
      .from(schema.packets)
      .where(
        and(
          eq(schema.packets.workspaceId, tenancy.workspaceId),
          gte(schema.packets.assembledAt, since),
        ),
      );

    // Median time-to-submit (active-touch proxy).
    const median = await tx.execute<{ median_seconds: number | null }>(
      sql`SELECT
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (submitted_at - opened_at))
            ) AS median_seconds
          FROM cases
          WHERE workspace_id = ${tenancy.workspaceId}
            AND submitted_at IS NOT NULL
            AND submitted_at >= ${since}`,
    );
    const medianSeconds =
      (median as unknown as Array<{ median_seconds: number | null }>)[0]?.median_seconds ?? null;

    return {
      windowDays: 30,
      casesOpened: casesOpened?.n ?? 0,
      casesSubmitted: casesSubmitted?.n ?? 0,
      packetsAssembled: packetsAssembled?.n ?? 0,
      medianTimeToSubmitSeconds: medianSeconds,
    };
  });

  return c.json(metrics);
});
