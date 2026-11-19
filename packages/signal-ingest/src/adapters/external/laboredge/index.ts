// LaborEdge VMS adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const laborEdgeAdapter = makeExternalStub({
  name: "laboredge",
  supports: ["providers", "jobs", "credentials"] as const,
  cadenceMs: 30 * 60 * 1000,
  description: "LaborEdge VMS",
  requiredCredentials: ["apiKey", "accountId"],
  requiredScopes: ["read:jobs", "read:candidates", "read:credentials"],
  requiredEnv: ["SIGNAL_LABOREDGE_BASE_URL"],
  docs: "https://api.laboredge.com/docs",
});
