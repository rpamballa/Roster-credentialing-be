import { env } from "@cred/config";
import { type Logger, pino, stdTimeFunctions } from "pino";

const cfg = env();

// Structured logger. Entity IDs and structural diffs only — never PHI (§4.4).
export const logger: Logger = pino({
  level: cfg.LOG_LEVEL,
  base: { service: "cred-backend", env: cfg.NODE_ENV },
  redact: {
    paths: [
      "*.email",
      "*.phone",
      "*.dob",
      "*.ssn",
      "*.ssnEncrypted",
      "*.firstName",
      "*.lastName",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "<REDACTED>",
  },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: stdTimeFunctions.isoTime,
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
