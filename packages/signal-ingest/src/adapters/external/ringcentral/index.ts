// RingCentral adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const ringCentralAdapter = makeExternalStub({
  name: "ringcentral",
  supports: ["conversations"] as const,
  cadenceMs: 10 * 60 * 1000,
  description: "RingCentral (voice + SMS)",
  requiredCredentials: ["clientId", "clientSecret", "jwtToken"],
  requiredScopes: ["ReadCallLog", "ReadMessages"],
  requiredEnv: ["SIGNAL_RINGCENTRAL_SERVER_URL"],
  docs: "https://developers.ringcentral.com/api-reference",
});
