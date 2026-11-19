// Gmail adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const gmailAdapter = makeExternalStub({
  name: "gmail",
  supports: ["conversations"] as const,
  cadenceMs: 10 * 60 * 1000,
  description: "Gmail (Google Workspace)",
  requiredCredentials: ["clientId", "clientSecret", "refreshToken", "userEmail"],
  requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  requiredEnv: [],
  docs: "https://developers.google.com/gmail/api/guides",
});
