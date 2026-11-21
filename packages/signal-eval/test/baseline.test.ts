import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Baseline, checkBaseline, loadBaseline, writeBaseline } from "../src/baseline.js";

function baseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    fixture: "known-reqs-v0.json",
    k: 3,
    meanPrecisionAtK: null,
    toleranceDrop: 0.02,
    updatedAt: null,
    recordedBy: null,
    ...overrides,
  };
}

describe("checkBaseline", () => {
  it("absolute threshold: passes when current >= threshold", () => {
    const g = checkBaseline({ current: 0.72, threshold: 0.7, baseline: baseline() });
    expect(g.thresholdPass).toBe(true);
    expect(g.pass).toBe(true);
  });

  it("absolute threshold: fails when current < threshold", () => {
    const g = checkBaseline({ current: 0.65, threshold: 0.7, baseline: baseline() });
    expect(g.thresholdPass).toBe(false);
    expect(g.pass).toBe(false);
  });

  it("skips regression check when baseline is null", () => {
    const g = checkBaseline({
      current: 0.72,
      threshold: 0.7,
      baseline: baseline({ meanPrecisionAtK: null }),
    });
    expect(g.regressionPass).toBe(true);
    expect(g.regressionMessage).toMatch(/SKIP/);
  });

  it("fails when current regresses more than toleranceDrop", () => {
    const g = checkBaseline({
      current: 0.75,
      threshold: 0.7,
      baseline: baseline({ meanPrecisionAtK: 0.8, toleranceDrop: 0.02 }),
    });
    expect(g.thresholdPass).toBe(true);
    expect(g.regressionPass).toBe(false);
    expect(g.pass).toBe(false);
    expect(g.regressionMessage).toMatch(/FAIL/);
  });

  it("passes when current regresses but within toleranceDrop", () => {
    const g = checkBaseline({
      current: 0.79,
      threshold: 0.7,
      baseline: baseline({ meanPrecisionAtK: 0.8, toleranceDrop: 0.02 }),
    });
    expect(g.regressionPass).toBe(true);
    expect(g.pass).toBe(true);
  });
});

describe("writeBaseline / loadBaseline", () => {
  it("round-trips through the filesystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-eval-baseline-"));
    const path = join(dir, "baseline.json");
    const b = baseline({
      meanPrecisionAtK: 0.81,
      updatedAt: "2026-11-07T00:00:00Z",
      recordedBy: "ci",
    });
    writeBaseline(path, b);
    const loaded = loadBaseline(path);
    expect(loaded.meanPrecisionAtK).toBe(0.81);
    expect(loaded.updatedAt).toBe("2026-11-07T00:00:00Z");
    // and the file is pretty-printed
    const raw = readFileSync(path, "utf8");
    expect(raw).toMatch(/\n {2}/);
  });
});
