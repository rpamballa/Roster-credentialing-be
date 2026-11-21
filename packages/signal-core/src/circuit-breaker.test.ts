// Tests for the per-key circuit breaker.
//
// Every test drives time via an injected `now()` so the suite runs in
// milliseconds and doesn't depend on `vi.useFakeTimers` — the clock is
// an explicit parameter of the breaker.

import { beforeEach, describe, expect, it } from "vitest";
import { CircuitOpenError, createCircuitBreaker } from "./circuit-breaker.js";

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("createCircuitBreaker", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
  });

  it("stays closed while below the error threshold", async () => {
    const breaker = createCircuitBreaker({
      key: "test",
      errorThreshold: 0.5,
      cooldownMs: 1000,
      windowSize: 4,
      minSamples: 4,
      now: clock.now,
    });

    // 1 failure out of 4 = 25% — well below the 50% threshold.
    await breaker.run(() => Promise.resolve("ok"));
    await breaker.run(() => Promise.resolve("ok"));
    await breaker.run(() => Promise.resolve("ok"));
    await expect(breaker.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    expect(breaker.state()).toBe("closed");
  });

  it("trips open when the failure rate crosses the threshold", async () => {
    const breaker = createCircuitBreaker({
      key: "test",
      errorThreshold: 0.5,
      cooldownMs: 1000,
      windowSize: 4,
      minSamples: 4,
      now: clock.now,
    });

    // Two successes, then two failures → 2/4 = 50% → trip.
    await breaker.run(() => Promise.resolve("ok"));
    await breaker.run(() => Promise.resolve("ok"));
    await expect(breaker.run(() => Promise.reject(new Error("e1")))).rejects.toThrow("e1");
    await expect(breaker.run(() => Promise.reject(new Error("e2")))).rejects.toThrow("e2");

    expect(breaker.state()).toBe("open");
  });

  it("stays closed while the sample size is below minSamples", async () => {
    const breaker = createCircuitBreaker({
      key: "test",
      errorThreshold: 0.1, // intentionally easy to trip
      cooldownMs: 1000,
      windowSize: 10,
      minSamples: 5, // but we need at least 5 samples first
      now: clock.now,
    });

    // One failure, rate = 100%, but we're below minSamples → no trip.
    await expect(breaker.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(breaker.state()).toBe("closed");
  });

  it("rejects with CircuitOpenError while open and inside the cooldown", async () => {
    const breaker = createCircuitBreaker({
      key: "integration-x",
      errorThreshold: 0.5,
      cooldownMs: 5000,
      windowSize: 2,
      minSamples: 2,
      now: clock.now,
    });

    // Trip the breaker with two consecutive failures.
    await expect(breaker.run(() => Promise.reject(new Error("e1")))).rejects.toThrow("e1");
    await expect(breaker.run(() => Promise.reject(new Error("e2")))).rejects.toThrow("e2");
    expect(breaker.state()).toBe("open");

    // A call while open rejects with CircuitOpenError — fn is never
    // invoked. We assert both the error shape and that no side-effect
    // ran via the `called` sentinel.
    let called = false;
    const err = await breaker
      .run(() => {
        called = true;
        return "unreachable";
      })
      .catch((e) => e);

    expect(called).toBe(false);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).breakerKey).toBe("integration-x");
  });

  it("moves to half_open after the cooldown and allows exactly one probe", async () => {
    const breaker = createCircuitBreaker({
      key: "test",
      errorThreshold: 0.5,
      cooldownMs: 1000,
      windowSize: 2,
      minSamples: 2,
      now: clock.now,
    });

    await expect(breaker.run(() => Promise.reject(new Error("e1")))).rejects.toThrow();
    await expect(breaker.run(() => Promise.reject(new Error("e2")))).rejects.toThrow();
    expect(breaker.state()).toBe("open");

    // Advance past the cooldown. The next call is the probe.
    clock.advance(1001);

    // The probe fails → breaker re-opens with a fresh cooldown.
    await expect(breaker.run(() => Promise.reject(new Error("probe-fail")))).rejects.toThrow(
      "probe-fail",
    );
    expect(breaker.state()).toBe("open");

    // Immediately after, we're back inside the fresh cooldown — more
    // calls short-circuit without invoking fn.
    await expect(breaker.run(() => Promise.resolve("nope"))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it("re-closes on a successful probe and clears the failure history", async () => {
    const breaker = createCircuitBreaker({
      key: "test",
      errorThreshold: 0.5,
      cooldownMs: 1000,
      windowSize: 2,
      minSamples: 2,
      now: clock.now,
    });

    await expect(breaker.run(() => Promise.reject(new Error("e1")))).rejects.toThrow();
    await expect(breaker.run(() => Promise.reject(new Error("e2")))).rejects.toThrow();
    expect(breaker.state()).toBe("open");

    clock.advance(1001);

    // Successful probe — breaker closes, outcome history resets.
    const result = await breaker.run(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(breaker.state()).toBe("closed");

    // Because the window was wiped, a single new failure does NOT
    // immediately re-trip (we're below minSamples again).
    await expect(breaker.run(() => Promise.reject(new Error("post-recover")))).rejects.toThrow();
    expect(breaker.state()).toBe("closed");
  });

  it("supports synchronous functions", async () => {
    const breaker = createCircuitBreaker({
      key: "sync",
      errorThreshold: 0.5,
      cooldownMs: 1000,
      windowSize: 2,
      minSamples: 2,
      now: clock.now,
    });

    const value = await breaker.run(() => 42);
    expect(value).toBe(42);
  });

  it("rejects construction with an out-of-range error threshold", () => {
    expect(() =>
      createCircuitBreaker({
        key: "bad",
        errorThreshold: 1.5,
        cooldownMs: 1000,
      }),
    ).toThrow(RangeError);
  });
});
