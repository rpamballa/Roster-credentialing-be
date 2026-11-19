// Bullhorn ATS adapter — STUB. See README.md for the auth handshake
// and quirks list.
import { makeExternalStub } from "../makeStub.js";

export const bullhornAdapter = makeExternalStub({
  name: "bullhorn",
  supports: ["providers", "jobs", "credentials", "conversations"] as const,
  cadenceMs: 15 * 60 * 1000,
  description: "Bullhorn ATS",
  requiredCredentials: ["clientId", "clientSecret", "refreshToken", "restUrl"],
  requiredScopes: ["READ"],
  requiredEnv: ["SIGNAL_BULLHORN_LOGIN_URL"],
  docs: "https://bullhorn.github.io/rest-api-docs/",
});
