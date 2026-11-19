// Twilio adapter — STUB.
import { makeExternalStub } from "../makeStub.js";

export const twilioAdapter = makeExternalStub({
  name: "twilio",
  supports: ["conversations"] as const,
  cadenceMs: 10 * 60 * 1000,
  description: "Twilio (SMS)",
  requiredCredentials: ["accountSid", "authToken"],
  requiredScopes: [],
  requiredEnv: [],
  docs: "https://www.twilio.com/docs/api",
});
