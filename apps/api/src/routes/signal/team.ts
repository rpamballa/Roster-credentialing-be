// Roster Signal · GET /v1/signal/team
//
// Returns the specialists (staff members of the current workspace) grouped
// with the providers they "own." The visualization at /signal/team on the
// FE renders this as a hub-and-spoke network.
//
// Ownership attribution:
//
//   The canonical Signal data model does not yet carry a column tying a
//   signal_conversations row to the specialist who made the touch — all
//   conversation attribution today is agency-scoped. Until that column
//   lands we assign each provider to a specialist deterministically by
//   hashing the provider id and taking `hash % specialists.length`. This:
//
//     - is stable across page loads for the same workspace
//     - distributes providers roughly evenly across specialists
//     - never leaks into the canonical data (it is computed per-request)
//     - will be replaced by `signal_conversations.specialist_id` when
//       that column is added (follow-up task)
//
// A comment-of-record sits in the response as `attribution: "deterministic-hash"`
// so a future BE change to real attribution can be read by the FE without
// a schema negotiation.
//
// Tenancy: read-only, workspace-scoped on every predicate. No writes.

import { db, schema } from "@cred/db";
import { desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { ApiBindings } from "../../types.js";

interface TeamProvider {
  id: string;
  name: string;
  specialty: string | null;
  conversationCount: number;
  lastActivityAt: string | null;
  engagementTier: "active" | "warming" | "cooling" | "dormant";
}

interface TeamSpecialist {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
  providers: TeamProvider[];
}

interface TeamResponse {
  workspaceId: string;
  attribution: "deterministic-hash";
  specialists: TeamSpecialist[];
  unassignedCount: number;
}

/**
 * Deterministic hash of a provider id → specialist bucket index.
 *
 * Uses a cheap non-cryptographic hash (sum of char codes) because:
 *   - we only need distribution, not security
 *   - the function must be reproducible from the FE and here agree on
 *     the same specialist for the same provider across reads
 *
 * NOTE: when the real `specialist_id` column lands, delete this
 * function and read ownership from the row.
 */
function bucket(providerId: string, modulo: number): number {
  if (modulo <= 0) return 0;
  let h = 0;
  for (let i = 0; i < providerId.length; i++) {
    h = (h * 31 + providerId.charCodeAt(i)) >>> 0;
  }
  return h % modulo;
}

/**
 * Convert "days since last activity" into the four engagement tiers Signal
 * already shows on the providers call list, so the colours on the network
 * view match the colours a recruiter sees elsewhere.
 */
function engagementTier(daysSinceLast: number | null): TeamProvider["engagementTier"] {
  if (daysSinceLast === null) return "dormant";
  if (daysSinceLast <= 7) return "active";
  if (daysSinceLast <= 21) return "warming";
  if (daysSinceLast <= 60) return "cooling";
  return "dormant";
}

function initialsOf(name: string, email: string): string {
  const source = (name ?? "").trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

export function mountTeamRoutes(signalRoutes: Hono<ApiBindings>): void {
  signalRoutes.get("/v1/signal/team", async (c: Context<ApiBindings>) => {
    const { workspaceId } = c.var.signalTenancy;

    // ── Specialists: workspace memberships + user name/email ──────────
    const memberships = await db()
      .select({
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.workspaceId, workspaceId));

    // Deterministic order by email for stable network layout across loads.
    const specialists = memberships
      .map((m) => ({
        id: m.userId,
        name: m.name ?? m.email,
        email: m.email,
        role: m.role,
      }))
      .sort((a, b) => a.email.localeCompare(b.email));

    // ── Providers: every signal_provider in this workspace ────────────
    const providers = await db()
      .select({
        id: schema.signalProviders.id,
        name: schema.signalProviders.name,
        specialties: schema.signalProviders.specialties,
      })
      .from(schema.signalProviders)
      .where(eq(schema.signalProviders.workspaceId, workspaceId));

    // ── Conversation rollup: count + last touch per provider ──────────
    // One query that groups by provider_id. We only read rows belonging
    // to this workspace (both predicates on the join and the WHERE
    // clause to keep the row-level-security contract tight).
    const rollupRows = await db()
      .select({
        providerId: schema.signalConversations.providerId,
        occurredAt: schema.signalConversations.occurredAt,
      })
      .from(schema.signalConversations)
      .where(eq(schema.signalConversations.workspaceId, workspaceId))
      .orderBy(desc(schema.signalConversations.occurredAt));

    const rollup = new Map<
      string,
      { count: number; last: Date | null }
    >();
    for (const row of rollupRows) {
      if (!row.providerId) continue;
      const bucket = rollup.get(row.providerId);
      if (bucket) {
        bucket.count += 1;
      } else {
        rollup.set(row.providerId, { count: 1, last: row.occurredAt });
      }
    }

    // ── Assign each provider to a specialist bucket deterministically ─
    const now = Date.now();
    const bucketed: Map<string, TeamProvider[]> = new Map();
    let unassignedCount = 0;

    if (specialists.length === 0) {
      // Edge case: workspace with no memberships. Everything is
      // unassigned and the response has zero specialists.
      unassignedCount = providers.length;
    } else {
      for (const s of specialists) bucketed.set(s.id, []);
      for (const p of providers) {
        const idx = bucket(p.id, specialists.length);
        const owner = specialists[idx];
        if (!owner) continue;
        const bucketForOwner = bucketed.get(owner.id);
        if (!bucketForOwner) continue;
        const r = rollup.get(p.id);
        const daysSinceLast = r?.last
          ? Math.max(0, Math.floor((now - r.last.getTime()) / (24 * 3600 * 1000)))
          : null;
        bucketForOwner.push({
          id: p.id,
          name: p.name,
          specialty: p.specialties?.[0] ?? null,
          conversationCount: r?.count ?? 0,
          lastActivityAt: r?.last ? r.last.toISOString() : null,
          engagementTier: engagementTier(daysSinceLast),
        });
      }
    }

    const body: TeamResponse = {
      workspaceId,
      attribution: "deterministic-hash",
      specialists: specialists.map((s) => ({
        ...s,
        initials: initialsOf(s.name, s.email),
        providers: (bucketed.get(s.id) ?? []).sort(
          // Most-engaged first, then by name
          (a, b) =>
            b.conversationCount - a.conversationCount || a.name.localeCompare(b.name),
        ),
      })),
      unassignedCount,
    };

    return c.json(body);
  });
}
