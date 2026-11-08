// `@cred/signal-core` — shared primitives for Roster Signal services.
//
// WS H ships only the circuit breaker; later workstreams will add the
// scoring helpers, lineage utilities, and shared types here. Kept as a
// standalone package so Signal code lives in one import root and so
// its test surface (and dependency graph) stays small and auditable.

export * from "./circuit-breaker.js";
