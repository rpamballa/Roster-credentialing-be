/**
 * `@cred/signal-eval` · precision baseline
 * ----------------------------------------
 * CI compares each run's `meanPrecisionAtK` against the committed
 * baseline in `fixtures/baseline.json`. The gate has two checks:
 *
 *   - ABSOLUTE: current ≥ threshold (default 0.70). Blocks a merge
 *     whose eval drops below the agreed quality bar.
 *   - RELATIVE: current ≥ baseline.meanPrecisionAtK − toleranceDrop.
 *     Blocks a merge that regresses more than `toleranceDrop`
 *     (default 0.02 = 2 percentage points) from the recorded
 *     baseline, even when the absolute floor is met.
 *
 * The baseline is written by the committed `bin/update-baseline.ts`
 * script, not by the regular `signal-eval` run — this keeps a merge
 * from quietly moving its own baseline.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export interface Baseline {
  comment?: string;
  fixture: string;
  k: number;
  /** Mean precision@K at the recorded baseline. `null` means "no baseline yet". */
  meanPrecisionAtK: number | null;
  /** Max permitted drop from baseline before CI fails. Default 0.02. */
  toleranceDrop: number;
  updatedAt: string | null;
  recordedBy: string | null;
}

export interface BaselineGateArgs {
  current: number;
  threshold: number;
  baseline: Baseline;
}

export interface BaselineGateResult {
  thresholdPass: boolean;
  regressionPass: boolean;
  pass: boolean;
  thresholdMessage: string;
  regressionMessage: string;
}

export function loadBaseline(baselinePath: string): Baseline {
  const abs = pathResolve(baselinePath);
  const raw = readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw) as Baseline;
  if (typeof parsed.toleranceDrop !== "number") {
    throw new Error(`[signal-eval] baseline ${abs} is missing toleranceDrop`);
  }
  return parsed;
}

export function writeBaseline(baselinePath: string, baseline: Baseline): void {
  const abs = pathResolve(baselinePath);
  writeFileSync(abs, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export function checkBaseline(args: BaselineGateArgs): BaselineGateResult {
  const { current, threshold, baseline } = args;
  const thresholdPass = current + 1e-9 >= threshold;
  const thresholdMessage = thresholdPass
    ? `OK — current ${current.toFixed(4)} >= threshold ${threshold.toFixed(4)}`
    : `FAIL — current ${current.toFixed(4)} < threshold ${threshold.toFixed(4)}`;

  let regressionPass = true;
  let regressionMessage = "SKIP — no baseline recorded yet";
  if (typeof baseline.meanPrecisionAtK === "number") {
    const floor = baseline.meanPrecisionAtK - baseline.toleranceDrop;
    regressionPass = current + 1e-9 >= floor;
    regressionMessage = regressionPass
      ? `OK — current ${current.toFixed(4)} >= baseline ${baseline.meanPrecisionAtK.toFixed(4)} - tol ${baseline.toleranceDrop.toFixed(4)}`
      : `FAIL — current ${current.toFixed(4)} regressed > ${baseline.toleranceDrop.toFixed(4)} below baseline ${baseline.meanPrecisionAtK.toFixed(4)}`;
  }

  return {
    thresholdPass,
    regressionPass,
    pass: thresholdPass && regressionPass,
    thresholdMessage,
    regressionMessage,
  };
}
