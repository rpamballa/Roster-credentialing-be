export {
  CONSULTANT_LABEL_SOURCE,
  PLACEHOLDER_LABEL_SOURCE,
  allProviderIdsFromFixture,
  isPlaceholderFixture,
  loadFixture,
  validateFixture,
} from "./fixture.js";
export type { EvalFixture, EvalFixtureReq, LabelSource, SubSpecialty } from "./fixture.js";

export { mean, precisionAtK } from "./precision.js";
export type { PrecisionInputs, PrecisionOutputs } from "./precision.js";

export { seedFixture, seedFixtureForTenantB } from "./seed.js";
export type { SeedArgs, SeedResult } from "./seed.js";

export { runEval } from "./runEval.js";
export type {
  EvalAggregate,
  EvalResult,
  PerReqResult,
  RequirementShape,
  RunEvalArgs,
} from "./runEval.js";

export { runLeakProbe } from "./leak-probe.js";
export type { LeakProbeArgs, LeakProbeDiff, LeakProbeResult } from "./leak-probe.js";

export { checkBaseline, loadBaseline, writeBaseline } from "./baseline.js";
export type { Baseline, BaselineGateArgs, BaselineGateResult } from "./baseline.js";
