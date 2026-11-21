import { describe, expect, it } from "vitest";
import { mean, precisionAtK } from "../src/precision.js";

describe("precisionAtK", () => {
  it("returns 1.0 when the top-K is entirely in the expected set", () => {
    const r = precisionAtK({
      ranked: ["a", "b", "c", "d"],
      expected: ["a", "b", "c"],
      k: 3,
    });
    expect(r.precisionAtK).toBe(1);
    expect(r.hits).toEqual(["a", "b", "c"]);
    expect(r.misses).toEqual([]);
  });

  it("returns 0 when no top-K entry is in the expected set", () => {
    const r = precisionAtK({
      ranked: ["x", "y", "z"],
      expected: ["a", "b", "c"],
      k: 3,
    });
    expect(r.precisionAtK).toBe(0);
    expect(r.hits).toEqual([]);
    expect(r.misses).toEqual(["a", "b", "c"]);
  });

  it("denominator is K even when expected has fewer entries", () => {
    const r = precisionAtK({
      ranked: ["a", "x", "y"],
      expected: ["a"],
      k: 3,
    });
    // one hit / k=3 = 0.333..., NOT one hit / |expected|=1
    expect(r.precisionAtK).toBeCloseTo(1 / 3);
  });

  it("only considers the first K ranked", () => {
    const r = precisionAtK({
      ranked: ["x", "y", "z", "a", "b", "c"],
      expected: ["a", "b", "c"],
      k: 3,
    });
    expect(r.precisionAtK).toBe(0);
  });

  it("refuses non-positive K", () => {
    expect(() => precisionAtK({ ranked: ["a"], expected: ["a"], k: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => precisionAtK({ ranked: ["a"], expected: ["a"], k: -1 })).toThrow(
      /positive integer/,
    );
  });
});

describe("mean", () => {
  it("returns 0 for an empty input", () => {
    expect(mean([])).toBe(0);
  });

  it("averages correctly", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([0.5, 1.0])).toBe(0.75);
  });
});
