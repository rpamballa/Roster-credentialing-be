// Per-key circuit breaker for Roster Signal outbound calls.
//
// The three-state state machine:
//
//   closed    — requests flow through. Each failure is recorded; when
//               the failure rate over the recent window crosses
//               `errorThreshold`, the breaker trips to `open`.
//   open      — requests are rejected immediately with CircuitOpenError
//               until `cooldownMs` has elapsed since the trip, at which
//               point the first subsequent run transitions to
//               `half_open` and is allowed through as a probe.
//   half_open — exactly one probe is permitted. A success closes the
//               breaker (counters reset); a failure re-opens it with a
//               fresh cooldown window.
//
// Design choices worth calling out:
//
//   * Threshold is a RATE, not a raw count — see `errorThreshold` below.
//     A single transient error on an otherwise-healthy integration
//     shouldn't trip the breaker.
//
//   * Tracked over a rolling sliding window of the last `windowSize`
//     outcomes (default 10). Keeping the window bounded means a long-
//     lived breaker doesn't require retaining per-call timestamps
//     indefinitely.
//
//   * The breaker is per-key and lives in-process. Signal's v0 fits in
//     a single api replica; a distributed breaker is deferred until we
//     actually run multiple replicas. The `createCircuitBreaker` call
//     site owns the lifetime, so tests can spin up fresh breakers
//     without a global registry.
//
//   * Time is supplied via `now()` (default `Date.now`) so tests can
//     drive the clock without `vi.useFakeTimers`. This is the single
//     most important affordance for keeping the test suite fast — see
//     `circuit-breaker.test.ts`.

export type CircuitState = "closed" | "open" | "half_open";

export interface CreateCircuitBreakerOptions {
  /**
   * Opaque identifier the breaker uses for diagnostics (observability
   * tags, error messages). Keys are only compared by `===` within the
   * breaker; cross-breaker coordination (e.g. a shared registry) is
   * the caller's responsibility.
   */
  key: string;
  /**
   * Fraction of recent calls that must fail before the breaker trips.
   * `0.5` means "trip on >=50% failure rate across the last
   * `windowSize` calls". Must be in [0, 1].
   */
  errorThreshold: number;
  /** Milliseconds the breaker stays open before allowing a half-open probe. */
  cooldownMs: number;
  /**
   * Minimum sample size before the rate check can trip the breaker.
   * Below this we don't have enough signal — the breaker stays closed
   * regardless of the observed rate. Defaults to `windowSize`, which
   * means "fill the window first, then start evaluating".
   */
  minSamples?: number;
  /** Size of the rolling outcome window. Defaults to 10. */
  windowSize?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CircuitBreaker {
  readonly key: string;
  /** Current state. Read-only — only `run()` can mutate it. */
  state(): CircuitState;
  /**
   * Execute `fn`. When the breaker is `open` and the cooldown has not
   * yet elapsed, throws `CircuitOpenError` without invoking `fn`.
   * Otherwise forwards the result (or thrown error) from `fn`, after
   * recording the outcome against the rolling window.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Thrown by `breaker.run(...)` when the breaker is open and no probe
 * is permitted. Callers that want to fall back (cached response,
 * degraded answer, …) should catch this specifically.
 */
export class CircuitOpenError extends Error {
  readonly breakerKey: string;

  constructor(key: string) {
    super(`circuit breaker '${key}' is open`);
    this.name = "CircuitOpenError";
    this.breakerKey = key;
  }
}

export function createCircuitBreaker(opts: CreateCircuitBreakerOptions): CircuitBreaker {
  if (opts.errorThreshold < 0 || opts.errorThreshold > 1) {
    throw new RangeError(
      `errorThreshold must be in [0, 1] (got ${opts.errorThreshold} for key '${opts.key}')`,
    );
  }
  if (opts.cooldownMs < 0) {
    throw new RangeError(
      `cooldownMs must be non-negative (got ${opts.cooldownMs} for key '${opts.key}')`,
    );
  }

  const windowSize = opts.windowSize ?? 10;
  if (windowSize < 1) {
    throw new RangeError(`windowSize must be >= 1 (got ${windowSize} for key '${opts.key}')`);
  }

  const minSamples = opts.minSamples ?? windowSize;
  const now = opts.now ?? Date.now;

  // We keep the outcomes as a bounded FIFO array of booleans (true =
  // success, false = failure). `shift()` on an Array of length <= 10
  // is fine; swapping for a ring buffer would be premature.
  const outcomes: boolean[] = [];
  let state: CircuitState = "closed";
  let openedAt = 0;

  function record(success: boolean): void {
    outcomes.push(success);
    if (outcomes.length > windowSize) outcomes.shift();
  }

  function failureRate(): number {
    if (outcomes.length === 0) return 0;
    const failures = outcomes.reduce((n, ok) => (ok ? n : n + 1), 0);
    return failures / outcomes.length;
  }

  function trip(): void {
    state = "open";
    openedAt = now();
  }

  function reset(): void {
    state = "closed";
    outcomes.length = 0;
    openedAt = 0;
  }

  return {
    key: opts.key,
    state: () => state,
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      // When open, check whether we've waited out the cooldown. If so,
      // move to half_open and allow a single probe through. Otherwise
      // reject immediately.
      if (state === "open") {
        if (now() - openedAt < opts.cooldownMs) {
          throw new CircuitOpenError(opts.key);
        }
        state = "half_open";
      }

      // half_open and closed both proceed to run `fn`; the outcome
      // determines the next state.
      try {
        const result = await fn();
        if (state === "half_open") {
          // A successful probe re-closes the breaker and wipes the
          // prior failure history — we're declaring the dependency
          // healthy again.
          reset();
        } else {
          record(true);
        }
        return result;
      } catch (err) {
        if (state === "half_open") {
          // A failed probe trips the breaker again with a fresh
          // cooldown window. We keep the outcome record empty so the
          // next probe doesn't inherit stale pre-open failures.
          outcomes.length = 0;
          trip();
        } else {
          record(false);
          if (outcomes.length >= minSamples && failureRate() >= opts.errorThreshold) {
            trip();
          }
        }
        throw err;
      }
    },
  };
}
