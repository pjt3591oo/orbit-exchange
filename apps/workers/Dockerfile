# ADR-0005 — per-worker bulkhead container.
#
# Same image, different env var (WORKERS=<one>) per running container, so
# one worker's unhandled exception / OOM doesn't take down the others.
# See docker-compose.workers.yml for the compose overlay that spins up
# one container per worker.
#
# Multi-stage:
#   1. deps   — pnpm install (workspace-wide) so we get @orbit/shared etc.
#   2. build  — prisma generate + tsc
#   3. runner — pruned production node_modules + dist + prisma client
#
# Built from the repo ROOT context so we can copy the workspace layout.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate

# ───────── deps ─────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/workers/package.json apps/workers/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY packages/shared/package.json packages/shared/
COPY packages/observability/package.json packages/observability/
RUN pnpm install --frozen-lockfile

# ───────── build ─────────
FROM deps AS build
WORKDIR /repo
COPY packages/shared packages/shared
COPY packages/observability packages/observability
COPY apps/workers apps/workers
# Workers reads the same Prisma schema as api (single source of truth).
RUN pnpm --filter @orbit/shared build \
 && pnpm --filter @orbit/observability build \
 && pnpm --filter @orbit/workers build

# ───────── runner ─────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Copy workspace metadata + built artifacts. Skip dev deps via pnpm prune.
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages packages
COPY --from=build /repo/apps/workers apps/workers
COPY --from=build /repo/apps/api/prisma apps/api/prisma
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/node_modules node_modules

# Drop dev dependencies to shrink the runtime image.
RUN pnpm install --prod --frozen-lockfile --prefer-offline

WORKDIR /repo/apps/workers
ENV NODE_ENV=production
# Default to all-in-one (matches host dev). Compose overrides this per
# container to enable bulkhead.
ENV WORKERS=candle,fanout,notification,audit,outbox-relay,retry-30s,dlq-monitor

EXPOSE 3003
CMD ["node", "dist/main.js"]
