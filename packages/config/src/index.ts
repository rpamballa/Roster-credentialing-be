import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  API_PORT: z.coerce.number().int().positive().default(3001),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3001"),
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SESSION_SECRET: z.string().min(16),
  MAGIC_LINK_TTL_DAYS: z.coerce.number().int().positive().default(7),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default("cred-dev"),

  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("cred-default"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_SONNET: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MODEL_OPUS: z.string().default("claude-opus-4-7"),

  // Resend transactional email — used for magic-link and provider-invite sends.
  // Optional so dev + integration test runs (which don't need real email)
  // still boot; the send path itself must guard on `env().RESEND_API_KEY`
  // being present and log-fallback when it isn't.
  // Format guard: real Resend keys always start with `re_`. If someone
  // pastes the wrong secret (postgres password, Anthropic key, …) into
  // this slot, we want boot to fail loudly rather than call the API
  // with garbage.
  RESEND_API_KEY: z
    .string()
    .startsWith("re_", "RESEND_API_KEY must start with 're_' — check the value from Resend")
    .optional(),
  // Accepts either a bare email (`auth@rosterhealthcare.com`) or the
  // display-name form (`Roster Healthcare <auth@rosterhealthcare.com>`).
  // Resend accepts both; we accept both.
  RESEND_FROM_EMAIL: z
    .string()
    .refine(
      (v) => /^[^\s<>]+@[^\s<>]+\.[^\s<>]+$/.test(v) || /<[^\s<>]+@[^\s<>]+\.[^\s<>]+>$/.test(v),
      "RESEND_FROM_EMAIL must be an email or 'Name <email>' form",
    )
    .default("noreply@rosterhealthcare.com"),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  DOCUSIGN_INTEGRATION_KEY: z.string().optional(),
  DOCUSIGN_USER_ID: z.string().optional(),
  DOCUSIGN_ACCOUNT_ID: z.string().optional(),
  DOCUSIGN_PRIVATE_KEY: z.string().optional(),

  // Marketing lead intake — both optional.
  // SLACK_WEBHOOK_URL: incoming-webhook URL pinged when a new lead lands.
  // Empty/unset = no-op (logged only). Wire when the channel is ready.
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  // TURNSTILE_SECRET_KEY: Cloudflare Turnstile secret. When unset, server-side
  // verification is skipped (endpoint stays IP rate-limited regardless).
  // When set, requests without a valid token are rejected 400.
  TURNSTILE_SECRET_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function resetEnvForTesting(): void {
  cached = undefined;
}
