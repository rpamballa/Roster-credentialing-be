// Avionté staffing-platform adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const avionteAdapter = makeExternalStub({
  name: "avionte",
  supports: ["providers", "jobs", "credentials", "conversations"] as const,
  cadenceMs: 30 * 60 * 1000,
  description: "Avionté staffing platform",
  requiredCredentials: ["clientId", "clientSecret", "tenantId"],
  requiredScopes: ["candidates.read", "jobs.read", "placements.read"],
  requiredEnv: ["SIGNAL_AVIONTE_API_URL"],
  docs: "https://developer.avionte.com/",
});
