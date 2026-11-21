#!/usr/bin/env tsx
/**
 * `signal-eval update-baseline`
 * -----------------------------
 * Run the harness and write the current meanPrecisionAtK into
 * `fixtures/baseline.json`. The committed baseline moves only when
 * this script runs — regular `signal-eval` runs never write to it,
 * so a merge can't silently rebase its own regression floor.
 *
 * Usage mirrors `signal-eval`; the key difference is this script
 * UPDATES the baseline file on exit instead of gating on it.
 */

import { closeDb } from "@cred/db";
import { loadFixture, runEval, writeBaseline } from "../src/index.js";

interface Args {
  workspaceId: string;
  fixturePath: string;
  k: number;
  baselinePath: string;
  toleranceDrop: number;
  recordedBy: string;
}

const DEFAULT_K = 3;
const DEFAULT_TOLERANCE = 0.02;

function parseArgs(argv: readonly string[]): Args {
  const rest = [...argv];
  let workspaceId = "";
  let fixturePath = "";
  let k = DEFAULT_K;
  let baselinePath = "";
  let toleranceDrop = DEFAULT_TOLERANCE;
  let recordedBy = process.env.USER ?? "unknown";

  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case "--workspace":
      case "-w":
        workspaceId = rest.shift() ?? "";
        break;
      case "--fixture":
      case "-f":
        fixturePath = rest.shift() ?? "";
        break;
      case "--k":
      case "-k":
        k = Number.parseInt(rest.shift() ?? "", 10);
        break;
      case "--baseline":
      case "-b":
        baselinePath = rest.shift() ?? "";
        break;
      case "--tolerance":
        toleranceDrop = Number.parseFloat(rest.shift() ?? "");
        break;
      case "--recorded-by":
        recordedBy = rest.shift() ?? recordedBy;
        break;
      default:
        process.stderr.write(`[signal-eval update-baseline] unknown argument: ${arg}\n`);
        process.exit(2);
    }
  }
  if (!workspaceId || !fixturePath || !baselinePath) {
    process.stderr.write(
      "[signal-eval update-baseline] --workspace, --fixture and --baseline are required\n",
    );
    process.exit(2);
  }
  return {
    workspaceId,
    fixturePath,
    k,
    baselinePath,
    toleranceDrop,
    recordedBy,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadFixture(args.fixturePath);
  const result = await runEval({
    workspaceId: args.workspaceId,
    fixture,
    k: args.k,
  });
  const mean = result.aggregate.meanPrecisionAtK;
  writeBaseline(args.baselinePath, {
    comment:
      "Signal eval precision baseline. Updated by packages/signal-eval/bin/update-baseline.ts.",
    fixture: args.fixturePath,
    k: args.k,
    meanPrecisionAtK: mean,
    toleranceDrop: args.toleranceDrop,
    updatedAt: new Date().toISOString(),
    recordedBy: args.recordedBy,
  });
  process.stdout.write(
    `baseline updated: meanPrecision@${args.k} = ${mean.toFixed(4)} (${result.perReq.length} reqs)\n`,
  );
  await closeDb();
}

main().catch(async (err) => {
  process.stderr.write(
    `[signal-eval update-baseline] fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
