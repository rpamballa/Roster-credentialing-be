#!/usr/bin/env tsx
/**
 * `signal-eval` CLI
 * -----------------
 * Run the eval harness against a workspace and print a JSON report.
 * Exit code 0 when the precision gate passes, 1 when it fails.
 *
 * Usage:
 *
 *   signal-eval \
 *     --workspace <uuid> \
 *     --fixture packages/signal-eval/fixtures/known-reqs-v0.json \
 *     [--k 3] \
 *     [--threshold 0.70] \
 *     [--baseline packages/signal-eval/fixtures/baseline.json] \
 *     [--require-consultant-labels] \
 *     [--pretty]
 *
 * Environment:
 *   DATABASE_URL — the harness runs rankJobCandidates, which talks to
 *                  Postgres through @cred/db. If the eval workspace
 *                  isn't already seeded with the fixture's picks, the
 *                  CLI seeds it (TRUNCATE-first on signal_* tables is
 *                  the caller's job).
 */

import { closeDb } from "@cred/db";
import { type Baseline, checkBaseline, loadBaseline, loadFixture, runEval } from "../src/index.js";

interface Args {
  workspaceId: string;
  fixturePath: string;
  k: number;
  threshold: number;
  baselinePath?: string;
  requireConsultantLabels: boolean;
  pretty: boolean;
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_K = 3;

function parseArgs(argv: readonly string[]): Args {
  const rest = [...argv];
  let workspaceId = "";
  let fixturePath = "";
  let k = DEFAULT_K;
  let threshold = DEFAULT_THRESHOLD;
  let baselinePath: string | undefined;
  let requireConsultantLabels = false;
  let pretty = false;

  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case "--workspace":
      case "-w": {
        workspaceId = rest.shift() ?? "";
        break;
      }
      case "--fixture":
      case "-f": {
        fixturePath = rest.shift() ?? "";
        break;
      }
      case "--k":
      case "-k": {
        k = Number.parseInt(rest.shift() ?? "", 10);
        break;
      }
      case "--threshold":
      case "-t": {
        threshold = Number.parseFloat(rest.shift() ?? "");
        break;
      }
      case "--baseline":
      case "-b": {
        baselinePath = rest.shift();
        break;
      }
      case "--require-consultant-labels": {
        requireConsultantLabels = true;
        break;
      }
      case "--pretty": {
        pretty = true;
        break;
      }
      case "--help":
      case "-h": {
        printHelp();
        process.exit(0);
        break;
      }
      default: {
        process.stderr.write(`[signal-eval] unknown argument: ${arg}\n`);
        printHelp();
        process.exit(2);
      }
    }
  }

  if (!workspaceId) {
    process.stderr.write("[signal-eval] --workspace is required\n");
    process.exit(2);
  }
  if (!fixturePath) {
    process.stderr.write("[signal-eval] --fixture is required\n");
    process.exit(2);
  }
  if (!Number.isInteger(k) || k < 1) {
    process.stderr.write(`[signal-eval] --k must be a positive integer, got ${k}\n`);
    process.exit(2);
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    process.stderr.write(`[signal-eval] --threshold must be in [0, 1], got ${threshold}\n`);
    process.exit(2);
  }

  return {
    workspaceId,
    fixturePath,
    k,
    threshold,
    ...(baselinePath ? { baselinePath } : {}),
    requireConsultantLabels,
    pretty,
  };
}

function printHelp(): void {
  process.stderr.write(
    [
      "signal-eval — run Roster Signal's eval harness",
      "",
      "Usage:",
      "  signal-eval --workspace <uuid> --fixture <path> [options]",
      "",
      "Options:",
      "  --workspace, -w <uuid>       workspace to run against (required)",
      "  --fixture,   -f <path>       fixture JSON (required)",
      "  --k,         -k <int>        top-K cutoff for precision (default 3)",
      "  --threshold, -t <0..1>       absolute precision floor (default 0.70)",
      "  --baseline,  -b <path>       baseline JSON to gate regressions",
      "  --require-consultant-labels  refuse to run against placeholder fixtures",
      "  --pretty                     human-readable printout to stderr",
      "  --help, -h                   show this message",
      "",
      "Exits 0 on pass, 1 on gate failure, 2 on invalid usage.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadFixture(args.fixturePath);

  if (fixture.label_source === "placeholder-engineering-judgment") {
    process.stderr.write(
      "[signal-eval] WARN — this fixture carries ENGINEERING-PLACEHOLDER labels. " +
        "Consultant-grade labels are required before M10 prod promotion.\n",
    );
  }

  const result = await runEval({
    workspaceId: args.workspaceId,
    fixture,
    k: args.k,
    requireConsultantLabels: args.requireConsultantLabels,
  });

  const mean = result.aggregate.meanPrecisionAtK;
  const baseline: Baseline | null = args.baselinePath ? loadBaseline(args.baselinePath) : null;
  const gate = checkBaseline({
    current: mean,
    threshold: args.threshold,
    baseline: baseline ?? {
      fixture: args.fixturePath,
      k: args.k,
      meanPrecisionAtK: null,
      toleranceDrop: 0.02,
      updatedAt: null,
      recordedBy: null,
    },
  });

  const report = {
    workspaceId: result.workspaceId,
    fixtureVersion: result.fixtureVersion,
    labelSource: result.labelSource,
    isPlaceholder: result.isPlaceholder,
    k: result.k,
    threshold: args.threshold,
    baseline: baseline?.meanPrecisionAtK ?? null,
    toleranceDrop: baseline?.toleranceDrop ?? null,
    gate,
    aggregate: result.aggregate,
    perReq: result.perReq,
  };

  process.stdout.write(`${JSON.stringify(report, null, args.pretty ? 2 : 0)}\n`);

  if (args.pretty) {
    process.stderr.write(
      [
        "",
        `signal-eval summary (fixture=${result.fixtureVersion}, label=${result.labelSource})`,
        `  meanPrecision@${result.k} = ${mean.toFixed(4)}`,
        `  passed ${result.aggregate.passedCount}/${result.perReq.length}, ` +
          `failed ${result.aggregate.failedCount}`,
        `  threshold: ${gate.thresholdMessage}`,
        `  regression: ${gate.regressionMessage}`,
        "",
      ].join("\n"),
    );
  }

  await closeDb();
  process.exit(gate.pass ? 0 : 1);
}

main().catch(async (err) => {
  process.stderr.write(`[signal-eval] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
