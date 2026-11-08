/**
 * Circuit breaker behavior inside the runner.
 *
 * We don't want this test to depend on Postgres — we drive a custom
 * adapter whose readers throw on demand, and we point the runner at
 * `makeRunnerWithBreakers` so we can share breaker state across
 * multiple invocations.
 *
 * Acceptance line-item: "circuit breaker opens on repeated reader
 * errors".
 */

import { describe, expect, it } from "vitest";

import { createCircuitBreaker } from "@cred/signal-core";
import type { SignalIngestAdapter } from "../src/adapters/types.js";
import { makeRunnerWithBreakers } from "../src/runner.js";

function failingAdapter(name: string): SignalIngestAdapter {
  return {
    name,
    async readProviders() {
      throw new Error("providers reader is broken");
    },
    async readJobs() {
      return [];
    },
    async readFacilities() {
      return [];
    },
    async readCredentials() {
      return [];
    },
    async readConversations() {
      return [];
    },
  };
}

describe("runner · circuit breaker", () => {
  it("opens the providers breaker after repeated failures", async () => {
    const providers = createCircuitBreaker({
      key: "providers",
      errorThreshold: 0.5,
      cooldownMs: 60_000,
      minSamples: 2,
      windowSize: 4,
    });
    const breakers = {
      providers,
      jobs: createCircuitBreaker({
        key: "jobs",
        errorThreshold: 0.5,
        cooldownMs: 60_000,
        minSamples: 2,
        windowSize: 4,
      }),
      facilities: createCircuitBreaker({
        key: "facilities",
        errorThreshold: 0.5,
        cooldownMs: 60_000,
        minSamples: 2,
        windowSize: 4,
      }),
      credentials: createCircuitBreaker({
        key: "credentials",
        errorThreshold: 0.5,
        cooldownMs: 60_000,
        minSamples: 2,
        windowSize: 4,
      }),
      conversations: createCircuitBreaker({
        key: "conversations",
        errorThreshold: 0.5,
        cooldownMs: 60_000,
        minSamples: 2,
        windowSize: 4,
      }),
    };
    const run = makeRunnerWithBreakers(breakers);
    const adapter = failingAdapter("broken-adapter");

    // First call: providers reader throws → breaker still closed,
    // one failure recorded but minSamples requires 2.
    const s1 = await run(adapter, "00000000-0000-0000-0000-000000000000");
    expect(s1.errors.some((e) => e.reader === "providers")).toBe(true);
    expect(providers.state()).toBe("closed");

    // Second call: another failure → breaker opens.
    await run(adapter, "00000000-0000-0000-0000-000000000000");
    expect(providers.state()).toBe("open");

    // Third call: the breaker short-circuits providers; the error
    // reported by the runner notes the open state. Other readers
    // (which still return []) succeed as usual.
    const s3 = await run(adapter, "00000000-0000-0000-0000-000000000000");
    const providersError = s3.errors.find((e) => e.reader === "providers");
    expect(providersError).toBeDefined();
    expect(providersError?.openedCircuit).toBe(true);
  });
});
