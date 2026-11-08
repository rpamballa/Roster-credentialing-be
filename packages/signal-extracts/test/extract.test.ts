import { describe, expect, it } from "vitest";
import { type Facet, extract } from "../src/extract.js";

/**
 * Pure-function tests for the extractor. No DB.
 */
describe("extract — v0 facets", () => {
  function pick(body: string, facet: Facet): ReturnType<typeof extract> {
    return extract(body).filter((e) => e.facet === facet);
  }

  it("REGION_PREFERENCE — full state name, high confidence when near a preference verb", () => {
    const body = "Hi — I'd prefer Texas assignments for the next quarter.";
    const got = pick(body, "REGION_PREFERENCE");
    expect(got).toHaveLength(1);
    const first = got[0];
    if (!first) throw new Error("expected one match");
    expect(first.value).toMatchObject({ state: "TX", matched: "Texas" });
    expect(first.confidence).toBe(0.9);
    expect(body.slice(first.sourceSpan.start, first.sourceSpan.end)).toBe("Texas");
  });

  it("REGION_PREFERENCE — bare uppercase abbreviation gets the lowest tier", () => {
    const body = "Had some locums in CA last year.";
    const got = pick(body, "REGION_PREFERENCE");
    expect(got.map((e) => (e.value as { state: string }).state)).toContain("CA");
    expect(got.find((e) => (e.value as { state: string }).state === "CA")?.confidence).toBe(0.5);
  });

  it("REGION_PREFERENCE — lowercase 'or' inside prose is NOT confused for Oregon", () => {
    const body = "We'll meet tomorrow or Thursday to discuss.";
    const got = pick(body, "REGION_PREFERENCE");
    expect(got.filter((e) => (e.value as { state: string }).state === "OR")).toHaveLength(0);
  });

  it("TIMING_WINDOW — ISO date is exact (0.90)", () => {
    const body = "Starting on 2026-02-15 is ideal.";
    const got = pick(body, "TIMING_WINDOW");
    const iso = got.find((e) => (e.value as { kind: string }).kind === "date");
    expect(iso?.value).toMatchObject({ iso: "2026-02-15" });
    expect(iso?.confidence).toBe(0.9);
  });

  it("TIMING_WINDOW — month phrase (0.70)", () => {
    const body = "Available from January through March.";
    const got = pick(body, "TIMING_WINDOW");
    const monthMatch = got.find((e) => (e.value as { kind: string }).kind === "month");
    expect(monthMatch?.value).toMatchObject({ month: 1 });
    expect(monthMatch?.confidence).toBe(0.7);
  });

  it("TIMING_WINDOW — loose phrase (0.50)", () => {
    const body = "She's booked until further notice.";
    const got = pick(body, "TIMING_WINDOW");
    expect(got.some((e) => (e.value as { kind: string }).kind === "phrase")).toBe(true);
  });

  it("RATE_EXPECTATION — $180/hr with unit keyword lands 0.90", () => {
    const body = "Looking at $180/hr for night coverage.";
    const got = pick(body, "RATE_EXPECTATION");
    expect(got).toHaveLength(1);
    expect(got[0]?.value).toMatchObject({ amount: 180, unit: "hour" });
    expect(got[0]?.confidence).toBe(0.9);
  });

  it("RATE_EXPECTATION — bare '$200' with no nearby keyword lands 0.50", () => {
    const body = "Think about $200 as a starting point for the room.";
    const got = pick(body, "RATE_EXPECTATION");
    expect(got[0]?.value).toMatchObject({ amount: 200, unit: null });
    expect(got[0]?.confidence).toBe(0.5);
  });

  it("RATE_EXPECTATION — comma-separated amounts parse ($1,800/day)", () => {
    const body = "Day rate is $1,800/day typically.";
    const got = pick(body, "RATE_EXPECTATION");
    expect(got[0]?.value).toMatchObject({ amount: 1800, unit: "day" });
    expect(got[0]?.confidence).toBe(0.9);
  });

  it("SUBSPECIALTY_INTEREST — 'cardiac anesthesia' canonicalizes to 'cardiac'", () => {
    const body = "She wants cardiac anesthesia only.";
    const got = pick(body, "SUBSPECIALTY_INTEREST");
    expect(got.some((e) => (e.value as { subspecialty: string }).subspecialty === "cardiac")).toBe(
      true,
    );
  });

  it("SUBSPECIALTY_INTEREST — multiple subspecialties resolve independently", () => {
    const body = "Open to OB anesthesia and pediatric cases, no chronic pain clinic.";
    const got = pick(body, "SUBSPECIALTY_INTEREST");
    const subs = new Set(got.map((e) => (e.value as { subspecialty: string }).subspecialty));
    expect(subs.has("ob")).toBe(true);
    expect(subs.has("peds")).toBe(true);
    expect(subs.has("pain")).toBe(true);
  });

  it("AVAILABILITY_SIGNAL — positive polarity", () => {
    const body = "I'm available for weekend assignments.";
    const got = pick(body, "AVAILABILITY_SIGNAL");
    expect(got[0]?.value).toMatchObject({ polarity: "available" });
  });

  it("AVAILABILITY_SIGNAL — 'not available' flips polarity", () => {
    const body = "Not available until July — on assignment.";
    const got = pick(body, "AVAILABILITY_SIGNAL");
    expect(got.some((e) => (e.value as { polarity: string }).polarity === "unavailable")).toBe(
      true,
    );
  });

  it("empty body produces no extracts", () => {
    expect(extract("")).toEqual([]);
  });

  it("source_span offsets slice back to the original match", () => {
    const body = "Available from May 2026, rate $200/hr, prefers Texas.";
    for (const ex of extract(body)) {
      const slice = body.slice(ex.sourceSpan.start, ex.sourceSpan.end);
      expect(slice.length).toBeGreaterThan(0);
    }
  });
});
