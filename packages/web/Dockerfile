# ChePibe Personal Web (SvelteKit)
# Build context: repo root

ARG ALLOWED_PHONE

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:25-slim AS deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@latest

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/

RUN pnpm install --frozen-lockfile

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:25-slim AS builder
ARG ALLOWED_PHONE

WORKDIR /app

RUN npm install -g pnpm@latest

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/tsup.config.ts ./packages/shared/
RUN pnpm build:shared

COPY packages/web/src ./packages/web/src
COPY packages/web/tsconfig.json ./packages/web/
COPY packages/web/svelte.config.js ./packages/web/
COPY packages/web/vite.config.ts ./packages/web/
COPY packages/web/package.json ./packages/web/
COPY scripts ./scripts
ENV NODE_ENV=production \
    ALLOWED_PHONE=${ALLOWED_PHONE}
RUN pnpm build:web

# =============================================================================
# Stage 3: Production Runner
# =============================================================================
FROM node:25-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --home-dir /app --no-create-home nodejs

COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules

COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

COPY --from=builder --chown=nodejs:nodejs /app/packages/web/build ./packages/web/build
COPY --from=builder /app/packages/web/package.json ./packages/web/

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    ALLOWED_PHONE=${ALLOWED_PHONE}

EXPOSE 3000

USER nodejs

ENTRYPOINT ["dumb-init", "--"]

WORKDIR /app/packages/web
CMD ["node", "build/index.js"]
