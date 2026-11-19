// Salesforce CRM adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const salesforceCrmAdapter = makeExternalStub({
  name: "salesforce-crm",
  supports: ["providers", "jobs", "conversations"] as const,
  cadenceMs: 30 * 60 * 1000,
  description: "Salesforce CRM (Health Cloud or custom objects)",
  requiredCredentials: ["clientId", "clientSecret", "refreshToken", "instanceUrl"],
  requiredScopes: ["api", "refresh_token", "offline_access"],
  requiredEnv: ["SIGNAL_SALESFORCE_LOGIN_URL"],
  docs: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
});
