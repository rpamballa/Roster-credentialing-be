# Credentialing Platform — Backend

Backend monorepo for the agentic physician credentialing platform. See `SPEC.md` and `api_PROMPT.md`
for the authoritative architecture and scope.

## Quick start

Local infra (postgres, redis, gcs-emulator, temporal) is orchestrated
from the deploy repo — this repo no longer ships its own compose. See
`../roster-credentialing-deploy/README.md` for one-command bring-up.

For a bare `pnpm dev` on this checkout, point `DATABASE_URL`,
`REDIS_URL`, and the `GCS_*` / `STORAGE_EMULATOR_*` vars at whatever
containers you already have running (typically the deploy stack).

```bash
pnpm install
cp .env.example .env      # then edit to match your local infra
pnpm db:migrate
pnpm dev
```

## Layout

- `apps/api` — Hono REST + GraphQL Yoga server
- `apps/workers` — Temporal worker process
- `packages/db` — Drizzle schema, migrations, RLS policies
- `packages/auth` — Magic-link, sessions, OTP, WebAuthn (M1: magic-link only)
- `packages/observability` — pino + OTel + audit wrapper
- `packages/storage` — S3-compatible object storage + pgmq queue
- `packages/ai` — Anthropic SDK wrapper (no other file imports the SDK)
- `packages/types` — Shared domain + API types
- `packages/config` — Zod env schemas

## Current milestone

M1 — Foundation. See `api_PROMPT.md` §5.
