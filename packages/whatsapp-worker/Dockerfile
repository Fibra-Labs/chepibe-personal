# ChePibe Personal WhatsApp Worker
# Build context: repo root

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:24-alpine AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/whatsapp-worker/package.json ./packages/whatsapp-worker/

RUN pnpm install --frozen-lockfile

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/whatsapp-worker/package.json ./packages/whatsapp-worker/

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/whatsapp-worker/node_modules ./packages/whatsapp-worker/node_modules

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/drizzle ./packages/shared/drizzle
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/tsup.config.ts ./packages/shared/
RUN pnpm build:shared

COPY packages/whatsapp-worker/src ./packages/whatsapp-worker/src
COPY packages/whatsapp-worker/tsconfig.json ./packages/whatsapp-worker/
COPY packages/whatsapp-worker/tsup.config.ts ./packages/whatsapp-worker/
COPY scripts ./scripts
ENV NODE_ENV=production
RUN pnpm build:worker

# =============================================================================
# Stage 3: Production Runner
# =============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

RUN apk add --no-cache dumb-init su-exec

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 -G nodejs -D -H -h /app nodejs && \
    mkdir -p /data && chown nodejs:nodejs /data

COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/whatsapp-worker/node_modules ./packages/whatsapp-worker/node_modules

COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/drizzle ./packages/shared/drizzle

COPY --from=builder --chown=nodejs:nodejs /app/packages/whatsapp-worker/dist ./packages/whatsapp-worker/dist
COPY --from=builder /app/packages/whatsapp-worker/package.json ./packages/whatsapp-worker/

COPY packages/whatsapp-worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATABASE_URL=file:/data/chepibe-personal.db

ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]

WORKDIR /app/packages/whatsapp-worker
CMD ["node", "dist/main.mjs"]