import { describe, expect, it } from "vitest";
import {
  CONSULTANT_LABEL_SOURCE,
  type EvalFixture,
  PLACEHOLDER_LABEL_SOURCE,
  allProviderIdsFromFixture,
  isPlaceholderFixture,
  loadFixture,
  validateFixture,
} from "../src/fixture.js";

function okFixture(overrides: Partial<EvalFixture> = {}): EvalFixture {
  return {
    fixture_version: "v0",
    pilot_specialty: "locum-tenens-anesthesiology",
    label_source: PLACEHOLDER_LABEL_SOURCE,
    label_source_note: "note",
    reqs: [
      {
        reqId: "req-01",
        facilityState: "MA",
        subSpecialty: "cardiac",
        needDate: "2026-02-15",
        payRange: [1000, 2000],
        placeholderTopPicks: ["a", "b"],
        rationale: "because",
      },
    ],
    ...overrides,
  };
}

describe("loadFixture", () => {
  const fixturePath = new URL("../fixtures/known-reqs-v0.json", import.meta.url).pathname;

  it("loads and validates the v0 fixture", () => {
    const fx = loadFixture(fixturePath);
    expect(fx.reqs.length).toBeGreaterThanOrEqual(20);
    expect(fx.reqs.length).toBeLessThanOrEqual(30);
  });

  it("the v0 fixture spans every sub-specialty roughly evenly", () => {
    const fx = loadFixture(fixturePath);
    const counts: Record<string, number> = {
      cardiac: 0,
      ob: 0,
      pediatric: 0,
      pain: 0,
      general: 0,
    };
    for (const r of fx.reqs) counts[r.subSpecialty] = (counts[r.subSpecialty] ?? 0) + 1;
    for (const k of Object.keys(counts)) {
      expect(counts[k], `${k} count`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the v0 fixture is marked as placeholder-labeled", () => {
    const fx = loadFixture(fixturePath);
    expect(fx.label_source).toBe(PLACEHOLDER_LABEL_SOURCE);
    expect(isPlaceholderFixture(fx)).toBe(true);
  });
});

describe("validateFixture", () => {
  it("accepts a well-formed fixture", () => {
    expect(() => validateFixture(okFixture(), "ok")).not.toThrow();
  });

  it("rejects an empty reqs array", () => {
    expect(() => validateFixture(okFixture({ reqs: [] }), "bad")).toThrow(/no reqs/);
  });

  it("rejects a req with an empty placeholderTopPicks array", () => {
    const fx = okFixture({
      reqs: [
        {
          reqId: "req-01",
          facilityState: "MA",
          subSpecialty: "cardiac",
          needDate: "2026-02-15",
          payRange: [1000, 2000],
          placeholderTopPicks: [],
          rationale: "because",
        },
      ],
    });
    expect(() => validateFixture(fx, "bad")).toThrow(/empty placeholderTopPicks/);
  });

  it("rejects a req with a malformed payRange", () => {
    const fx = okFixture({
      reqs: [
        {
          reqId: "req-01",
          facilityState: "MA",
          subSpecialty: "cardiac",
          needDate: "2026-02-15",
          payRange: [1000] as unknown as [number, number],
          placeholderTopPicks: ["a"],
          rationale: "because",
        },
      ],
    });
    expect(() => validateFixture(fx, "bad")).toThrow(/bad payRange/);
  });

  it("isPlaceholderFixture distinguishes placeholder vs consultant labels", () => {
    expect(isPlaceholderFixture(okFixture({ label_source: PLACEHOLDER_LABEL_SOURCE }))).toBe(true);
    expect(isPlaceholderFixture(okFixture({ label_source: CONSULTANT_LABEL_SOURCE }))).toBe(false);
  });
});

describe("allProviderIdsFromFixture", () => {
  it("returns a sorted deduped list", () => {
    const fx = okFixture({
      reqs: [
        {
          reqId: "r1",
          facilityState: "MA",
          subSpecialty: "cardiac",
          needDate: "2026-02-15",
          payRange: [1000, 2000],
          placeholderTopPicks: ["b", "a"],
          rationale: "",
        },
        {
          reqId: "r2",
          facilityState: "MA",
          subSpecialty: "cardiac",
          needDate: "2026-02-15",
          payRange: [1000, 2000],
          placeholderTopPicks: ["a", "c"],
          rationale: "",
        },
      ],
    });
    expect(allProviderIdsFromFixture(fx)).toEqual(["a", "b", "c"]);
  });
});
