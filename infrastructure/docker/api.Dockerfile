# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=$PNPM_HOME:$PATH \
    NODE_ENV=production
RUN corepack enable

# ─── deps ─────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.json tsconfig.base.json biome.json ./
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/
COPY packages packages/
RUN pnpm install --frozen-lockfile --filter @cred/api... --filter @cred/db...

# ─── build ────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @cred/api... build

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system app && useradd --system --gid app --home /app app

COPY --from=build /repo /app
USER app
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
