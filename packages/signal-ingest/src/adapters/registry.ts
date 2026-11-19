/**
 * Adapter registry — the ONE place that knows every adapter name.
 *
 * The scheduler and HTTP routes look adapters up here rather than
 * passing instances around, so adding a new vendor is a one-line
 * change here and nothing else needs to learn the name. The
 * registry is immutable at runtime — tests that need a trimmed
 * registry use `createRegistry` to build their own.
 */

import type { AdapterContract } from "./contract.js";
import { rosterInternalAdapter } from "./rosterInternal.js";
import { avionteAdapter } from "./external/avionte/index.js";
import { bullhornAdapter } from "./external/bullhorn/index.js";
import { gmailAdapter } from "./external/gmail/index.js";
import { laborEdgeAdapter } from "./external/laboredge/index.js";
import { outlookAdapter } from "./external/outlook/index.js";
import { ringCentralAdapter } from "./external/ringcentral/index.js";
import { salesforceCrmAdapter } from "./external/salesforce-crm/index.js";
import { twilioAdapter } from "./external/twilio/index.js";

export class UnknownAdapterError extends Error {
  readonly adapter: string;
  constructor(adapter: string, known: string[]) {
    super(`unknown adapter '${adapter}' (known: ${known.join(", ")})`);
    this.name = "UnknownAdapterError";
    this.adapter = adapter;
  }
}

export interface AdapterRegistry {
  all(): AdapterContract[];
  names(): string[];
  has(name: string): boolean;
  get(name: string): AdapterContract;
}

/**
 * Build an adapter registry from an explicit list. Tests use this to
 * get a minimal registry (e.g. just `roster-internal`). Production
 * callers want the default registry below.
 */
export function createRegistry(adapters: readonly AdapterContract[]): AdapterRegistry {
  const byName = new Map<string, AdapterContract>();
  for (const a of adapters) {
    if (byName.has(a.name)) {
      throw new Error(`duplicate adapter name in registry: '${a.name}'`);
    }
    byName.set(a.name, a);
  }
  return {
    all: () => [...byName.values()],
    names: () => [...byName.keys()],
    has: (name) => byName.has(name),
    get(name) {
      const found = byName.get(name);
      if (!found) throw new UnknownAdapterError(name, [...byName.keys()]);
      return found;
    },
  };
}

/**
 * The default registry — every adapter we ship today. External
 * vendor adapters are stubs until their first customer onboards; the
 * scheduler still enumerates them for the health dashboard.
 */
export const defaultAdapterRegistry: AdapterRegistry = createRegistry([
  rosterInternalAdapter,
  bullhornAdapter,
  avionteAdapter,
  laborEdgeAdapter,
  salesforceCrmAdapter,
  gmailAdapter,
  outlookAdapter,
  ringCentralAdapter,
  twilioAdapter,
]);

/**
 * Convenience accessor — throws `UnknownAdapterError` for unknown
 * names. Prefer this over `defaultAdapterRegistry.get` in routes so
 * the error semantics are consistent.
 */
export function getAdapter(name: string): AdapterContract {
  return defaultAdapterRegistry.get(name);
}
