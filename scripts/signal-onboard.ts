/**
 * signal-onboard.ts
 *
 * Declarative agency onboarding. Replaces the ad-hoc "ops writes SQL
 * for each new agency" runbook with a single idempotent apply step:
 *
 *   docker compose exec api tsx scripts/signal-onboard.ts \
 *     /opt/roster/config/agencies/acme-locum.agency.json
 *
 * Flags:
 *   --dry-run                  parse + resolve credentials, print a plan, no writes
 *   --phase <name>             run only the named phase (comma-separated allowed)
 *   --allow-inline-in-prod     opt-in to inline credentials when NODE_ENV=production
 *
 * Phases, in order (every one is idempotent):
 *   1. workspace    ensure workspaces row by slug + signal_enabled
 *   2. specialists  upsert users by email + membership rows
 *   3. config       append signal_workspace_config rows (history-preserving)
 *   4. knowledge    upsert signal_knowledge_documents by title
 *   5. credentials  encrypt + upsert signal_adapter_credentials per enabled adapter
 *   6. adapters     optional preview/sync for each enabled adapter
 *   7. gaps         insert signal_onboarding_gaps rows missing by title
 *
 * Output: ONE JSON blob on the last stdout line (for jq); progress
 * logs go to stderr. See scripts/signal-dev-orchestrate.ts for the
 * same convention.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { db, schema } from "@cred/db";
import {
  type AdapterConfig,
  type AgencyConfig,
  preview as adapterPreview,
  runOnce as adapterRunOnce,
  defaultAdapterRegistry,
  parseAgencyConfig,
  resolveCredentials,
} from "@cred/signal-ingest";
import { encryptCredential } from "@cred/signal-knowledge";
import { and, eq, sql } from "drizzle-orm";

const ALL_PHASES = [
  "workspace",
  "specialists",
  "config",
  "knowledge",
  "credentials",
  "adapters",
  "gaps",
] as const;
type Phase = (typeof ALL_PHASES)[number];

interface CliArgs {
  configPath: string;
  dryRun: boolean;
  phases: Phase[];
  allowInlineInProd: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let configPath: string | undefined;
  let dryRun = false;
  let allowInlineInProd = false;
  const phases: Phase[] = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-inline-in-prod") allowInlineInProd = true;
    else if (a === "--phase") {
      const value = argv[++i];
      if (!value) throw new Error("--phase requires an argument");
      for (const p of value.split(",")) {
        if (!ALL_PHASES.includes(p as Phase)) {
          throw new Error(`unknown phase '${p}' (known: ${ALL_PHASES.join(", ")})`);
        }
        phases.push(p as Phase);
      }
    } else if (!a.startsWith("--") && !configPath) {
      configPath = a;
    } else {
      throw new Error(`unrecognized argument: ${a}`);
    }
  }

  if (!configPath) {
    throw new Error("usage: tsx scripts/signal-onboard.ts <config.json> [--dry-run]");
  }

  return {
    configPath: resolvePath(configPath),
    dryRun,
    phases: phases.length > 0 ? phases : [...ALL_PHASES],
    allowInlineInProd,
  };
}

function log(msg: string): void {
  process.stderr.write(`[onboard] ${msg}\n`);
}

// ─── Phase runners ─────────────────────────────────────────────────

async function ensureWorkspace(
  cfg: AgencyConfig,
): Promise<{ id: string; created: boolean; signalEnabledChanged: boolean }> {
  const [existing] = await db
    .select({
      id: schema.workspaces.id,
      signalEnabled: schema.workspaces.signalEnabled,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.slug, cfg.agency.slug))
    .limit(1);

  if (existing) {
    if (existing.signalEnabled !== cfg.agency.signalEnabled) {
      await db
        .update(schema.workspaces)
        .set({ signalEnabled: cfg.agency.signalEnabled })
        .where(eq(schema.workspaces.id, existing.id));
      return { id: existing.id, created: false, signalEnabledChanged: true };
    }
    return { id: existing.id, created: false, signalEnabledChanged: false };
  }

  const [created] = await db
    .insert(schema.workspaces)
    .values({
      type: cfg.agency.type,
      name: cfg.agency.name,
      slug: cfg.agency.slug,
      signalEnabled: cfg.agency.signalEnabled,
    })
    .returning({ id: schema.workspaces.id });

  return { id: created!.id, created: true, signalEnabledChanged: true };
}

async function ensureSpecialists(
  workspaceId: string,
  cfg: AgencyConfig,
): Promise<{ usersCreated: number; membershipsCreated: number }> {
  let usersCreated = 0;
  let membershipsCreated = 0;

  for (const s of cfg.specialists) {
    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, s.email))
      .limit(1);

    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const [created] = await db
        .insert(schema.users)
        .values({ email: s.email, name: s.name })
        .returning({ id: schema.users.id });
      userId = created!.id;
      usersCreated += 1;
    }

    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!membership) {
      await db.insert(schema.memberships).values({
        userId,
        workspaceId,
        role: s.role,
      });
      membershipsCreated += 1;
    }
  }

  return { usersCreated, membershipsCreated };
}

async function applyConfigEntries(
  workspaceId: string,
  cfg: AgencyConfig,
): Promise<{ written: number }> {
  if (cfg.config.length === 0) return { written: 0 };

  // The config table is append-only by design (writes new rows =
  // versions; readers pick the latest). We still skip if the latest
  // value is byte-equal to what we'd write, so re-applies don't bloat
  // history.
  let written = 0;
  for (const entry of cfg.config) {
    const [latest] = await db
      .select({ value: schema.signalWorkspaceConfig.value })
      .from(schema.signalWorkspaceConfig)
      .where(
        and(
          eq(schema.signalWorkspaceConfig.workspaceId, workspaceId),
          eq(schema.signalWorkspaceConfig.scope, entry.scope),
          eq(schema.signalWorkspaceConfig.key, entry.key),
        ),
      )
      .orderBy(sql`created_at DESC`)
      .limit(1);

    if (latest && JSON.stringify(latest.value) === JSON.stringify(entry.value)) continue;

    await db.insert(schema.signalWorkspaceConfig).values({
      workspaceId,
      scope: entry.scope,
      key: entry.key,
      value: entry.value as never,
    });
    written += 1;
  }
  return { written };
}

async function applyKnowledge(
  workspaceId: string,
  cfg: AgencyConfig,
): Promise<{ created: number; skipped: number }> {
  if (cfg.knowledge.length === 0) return { created: 0, skipped: 0 };

  const existing = await db
    .select({ title: schema.signalKnowledgeDocuments.title })
    .from(schema.signalKnowledgeDocuments)
    .where(
      and(
        eq(schema.signalKnowledgeDocuments.workspaceId, workspaceId),
        sql`${schema.signalKnowledgeDocuments.deletedAt} IS NULL`,
      ),
    );
  const existingTitles = new Set(existing.map((r) => r.title));

  let created = 0;
  let skipped = 0;
  for (const doc of cfg.knowledge) {
    if (existingTitles.has(doc.title)) {
      skipped += 1;
      continue;
    }
    await db.insert(schema.signalKnowledgeDocuments).values({
      workspaceId,
      title: doc.title,
      bodyMarkdown: doc.bodyMarkdown,
      tags: doc.tags,
    });
    created += 1;
  }
  return { created, skipped };
}

async function applyCredentials(
  workspaceId: string,
  cfg: AgencyConfig,
  allowInlineInProd: boolean,
): Promise<{ upserted: number; skipped: number; adapterConfigRows: number }> {
  let upserted = 0;
  let skipped = 0;
  let adapterConfigRows = 0;

  for (const [adapterName, entry] of Object.entries(cfg.adapters)) {
    if (!entry.enabled) {
      skipped += 1;
      continue;
    }
    // The schema guarantees credentials exist when enabled; this
    // assert is a belt-and-braces for refactors.
    if (!entry.credentials) {
      throw new Error(`internal: adapter '${adapterName}' enabled without credentials`);
    }

    const bag = resolveCredentials(adapterName, entry.credentials, { allowInlineInProd });
    const cipher = encryptCredential(workspaceId, adapterName, bag);

    await db
      .insert(schema.signalAdapterCredentials)
      .values({ workspaceId, adapter: adapterName, encryptedPayload: cipher })
      .onConflictDoUpdate({
        target: [
          schema.signalAdapterCredentials.workspaceId,
          schema.signalAdapterCredentials.adapter,
        ],
        set: {
          encryptedPayload: cipher,
          payloadVersion: sql`${schema.signalAdapterCredentials.payloadVersion} + 1`,
          rotatedAt: new Date(),
        },
      });
    upserted += 1;

    // Non-secret adapter config (base URLs, tenant ids) lands in the
    // workspace config KV under scope `adapter.<name>`.
    if (entry.config && Object.keys(entry.config).length > 0) {
      await db.insert(schema.signalWorkspaceConfig).values({
        workspaceId,
        scope: `adapter.${adapterName}`,
        key: "config",
        value: entry.config as never,
      });
      adapterConfigRows += 1;
    }
  }

  return { upserted, skipped, adapterConfigRows };
}

async function runAdapterKickoff(
  workspaceId: string,
  cfg: AgencyConfig,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  for (const [adapterName, entry] of Object.entries(cfg.adapters)) {
    if (!entry.enabled) continue;
    const hit: Record<string, unknown> = { adapter: adapterName };

    if (entry.runOnBootstrap.preview) {
      try {
        const out = await adapterPreview({ workspaceId, adapter: adapterName });
        hit.preview = {
          ok: out.ok,
          preview: out.preview,
          error: out.error ?? null,
          notImplemented: out.notImplemented ?? null,
        };
      } catch (err) {
        hit.preview = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (entry.runOnBootstrap.sync) {
      try {
        const out = await adapterRunOnce({ workspaceId, adapter: adapterName });
        hit.sync = {
          ok: out.ok,
          counts: out.counts,
          breakerState: out.breakerState,
          error: out.error ?? null,
          notImplemented: out.notImplemented ?? null,
        };
      } catch (err) {
        hit.sync = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    results.push(hit);
  }
  return results;
}

async function applyGaps(
  workspaceId: string,
  cfg: AgencyConfig,
): Promise<{ created: number; skipped: number }> {
  if (cfg.gaps.length === 0) return { created: 0, skipped: 0 };

  const existing = await db
    .select({ title: schema.signalOnboardingGaps.title })
    .from(schema.signalOnboardingGaps)
    .where(eq(schema.signalOnboardingGaps.workspaceId, workspaceId));
  const existingTitles = new Set(existing.map((r) => r.title));

  let created = 0;
  let skipped = 0;
  for (const gap of cfg.gaps) {
    if (existingTitles.has(gap.title)) {
      skipped += 1;
      continue;
    }
    await db.insert(schema.signalOnboardingGaps).values({
      workspaceId,
      title: gap.title,
      bodyMarkdown: gap.bodyMarkdown,
      status: gap.status,
    });
    created += 1;
  }
  return { created, skipped };
}

// ─── Plan + validation (dry-run) ───────────────────────────────────

function validateAdapters(cfg: AgencyConfig): void {
  const known = new Set(defaultAdapterRegistry.names());
  const bad = Object.keys(cfg.adapters).filter((n) => !known.has(n));
  if (bad.length > 0) {
    throw new Error(
      `unknown adapter name(s) in config: ${bad.join(", ")} (known: ${[...known].join(", ")})`,
    );
  }
}

function describePlan(
  cfg: AgencyConfig,
  resolvedAdapters: Record<string, AdapterConfig & { credentialKeys: string[] }>,
): Record<string, unknown> {
  return {
    agency: cfg.agency,
    specialists: cfg.specialists.length,
    configEntries: cfg.config.length,
    knowledgeDocs: cfg.knowledge.length,
    gaps: cfg.gaps.length,
    adapters: Object.entries(resolvedAdapters).map(([name, entry]) => ({
      name,
      enabled: entry.enabled,
      cadenceMsOverride: entry.cadenceMsOverride ?? null,
      credentialKeys: entry.credentialKeys,
      runOnBootstrap: entry.runOnBootstrap,
    })),
  };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const raw = readFileSync(args.configPath, "utf8");
  const cfg = parseAgencyConfig(JSON.parse(raw));
  validateAdapters(cfg);

  log(`parsed config for '${cfg.agency.slug}' (${cfg.agency.name})`);
  const runPhase = (p: Phase): boolean => args.phases.includes(p);

  // Resolve credentials up front so the plan print carries the shape
  // and so dry-run fails on missing env vars just like a real run.
  const resolvedAdapters: Record<string, AdapterConfig & { credentialKeys: string[] }> = {};
  for (const [name, entry] of Object.entries(cfg.adapters)) {
    if (entry.enabled && entry.credentials) {
      const bag = resolveCredentials(name, entry.credentials, {
        allowInlineInProd: args.allowInlineInProd,
      });
      resolvedAdapters[name] = { ...entry, credentialKeys: Object.keys(bag) };
    } else {
      resolvedAdapters[name] = { ...entry, credentialKeys: [] };
    }
  }

  if (args.dryRun) {
    const plan = describePlan(cfg, resolvedAdapters);
    process.stdout.write(`${JSON.stringify({ dryRun: true, plan }, null, 2)}\n`);
    return;
  }

  // ── execute ──
  const summary: Record<string, unknown> = { agency: cfg.agency };

  if (runPhase("workspace")) {
    const w = await ensureWorkspace(cfg);
    summary.workspace = w;
    log(`workspace ${w.created ? "created" : "found"}: ${w.id}`);
    summary.workspaceId = w.id;
  } else {
    // Downstream phases need the id — look it up.
    const [row] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, cfg.agency.slug))
      .limit(1);
    if (!row)
      throw new Error(
        `workspace '${cfg.agency.slug}' does not exist — run phase 'workspace' first`,
      );
    summary.workspaceId = row.id;
  }
  const workspaceId = summary.workspaceId as string;

  if (runPhase("specialists")) {
    summary.specialists = await ensureSpecialists(workspaceId, cfg);
    log(`specialists: ${JSON.stringify(summary.specialists)}`);
  }
  if (runPhase("config")) {
    summary.config = await applyConfigEntries(workspaceId, cfg);
    log(`config: ${JSON.stringify(summary.config)}`);
  }
  if (runPhase("knowledge")) {
    summary.knowledge = await applyKnowledge(workspaceId, cfg);
    log(`knowledge: ${JSON.stringify(summary.knowledge)}`);
  }
  if (runPhase("credentials")) {
    summary.credentials = await applyCredentials(workspaceId, cfg, args.allowInlineInProd);
    log(`credentials: ${JSON.stringify(summary.credentials)}`);
  }
  if (runPhase("adapters")) {
    summary.adapters = await runAdapterKickoff(workspaceId, cfg);
    log(`adapters: ${JSON.stringify(summary.adapters)}`);
  }
  if (runPhase("gaps")) {
    summary.gaps = await applyGaps(workspaceId, cfg);
    log(`gaps: ${JSON.stringify(summary.gaps)}`);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `[onboard] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
