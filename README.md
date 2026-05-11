# Credentialing Platform — Backend

Backend monorepo for the agentic physician credentialing platform. See `SPEC.md` and `api_PROMPT.md`
for the authoritative architecture and scope.

## Quick start

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio temporal
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
