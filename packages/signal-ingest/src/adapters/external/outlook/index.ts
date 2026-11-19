// Outlook (Microsoft 365) adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const outlookAdapter = makeExternalStub({
  name: "outlook",
  supports: ["conversations"] as const,
  cadenceMs: 10 * 60 * 1000,
  description: "Outlook / Microsoft 365",
  requiredCredentials: ["clientId", "clientSecret", "tenantId", "userEmail"],
  requiredScopes: ["Mail.Read", "offline_access"],
  requiredEnv: [],
  docs: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview",
});
