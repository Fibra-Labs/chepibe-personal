# Plan: Merge WhatsApp Worker into SvelteKit Web

## Current Architecture
- `packages/whatsapp-worker` runs an HTTP server (port 3001) with 4 REST routes: `/api/qr`, `/api/status`, `/api/sessions`, `/api/disconnect`
- `packages/web` (SvelteKit) proxies all worker calls via `WORKER_API_URL`
- The WhatsApp bot logic (`BaileysConnectionManager`, `GroqClient`, etc.) lives in the worker but is pure library code

## Goal
- Worker package → pure library exporting a `ChepibeBot` class
- Web package → SvelteKit starts its own server (as it does) AND instantiates the bot library directly, serving the API routes natively
- Single container deployment (one Node.js process)

## Files to Change

### Worker Package (`packages/whatsapp-worker`)
1. **Create `src/chepibe-bot.ts`**
   - `class ChepibeBot` with methods: `start()`, `getQR(sessionId?)`, `getStatus()`, `getSessions()`, `disconnect(sessionId)`, `destroy()`
   - Internal: event emitter for QR_READY, CONNECTED, DISCONNECTED
   - Reuse all of `main.ts` init logic (env → DB → migrations → BaileysConnectionManager → restore sessions → heartbeat)
2. **Create `src/index.ts`**
   - Export `ChepibeBot` and types (`BaileysSession`, `SessionStatus`, `TranscriptionResult`)
3. **Rewrite `src/main.ts`**
   - Remove `http.createServer`, QRCode, route handlers
   - Keep: env parsing, DB init, ChepibeBot instantiation + `await bot.start()`
   - Keep: shutdown handlers (SIGINT/SIGTERM)
4. **Update `package.json`**
   - `"main"`: `"./dist/index.js"`
   - Add `"exports"` for `"./chepibe-bot"` or just use index
   - Keep scripts: `dev` (non-server entry), `build`, `start`, `lint`
5. **Update `tsup.config.ts`**
   - Entry: `["src/index.ts", "src/main.ts"]` (or just index; main can be a secondary entry)
   - Actually tsup supports multiple entries: `entry: ["src/index.ts", "src/main.ts"]`
6. **Update `Dockerfile`** and `entrypoint.sh`
   - Worker container can still exist for standalone runs, but becomes optional
   - If kept, it will run `node dist/main.mjs` which starts the bot without a server

### Web Package (`packages/web`)
1. **Add dependency**
   - `"@chepibe-personal/whatsapp-worker": "workspace:*"`
2. **Create `src/lib/server/bot.ts`**
   - Instantiate `ChepibeBot` with runtime env vars
   - `await bot.start()`
   - `export { bot }`
   - Also wire SIGINT/SIGTERM to `bot.destroy()`
3. **Rewrite `src/lib/server/config.ts`**
   - Remove `WORKER_API_URL`
   - Keep `ALLOWED_PHONE`
4. **Rewrite API routes**
   - `src/routes/api/status/+server.ts`: `return Response.json(bot.getStatus())`
   - `src/routes/api/qr` does not exist as a file; QR is handled in `qr/+page.server.ts`. So we just update that.
   - `src/routes/api/sessions` does not exist; was only on the worker
   - `src/routes/api/disconnect` does not exist; the disconnect action is in `+page.server.ts`
5. **Rewrite `src/routes/+page.server.ts`**
   - `load`: call `bot.getStatus()` directly
   - `actions.default`: call `bot.disconnect(sessionId)` directly
6. **Rewrite `src/routes/qr/+page.server.ts`**
   - Call `bot.getQR(sessionId = searchParams.get('sessionId'))`
   - Convert QR string → data URL locally (qrcode lib is already a dependency)
7. **Rewrite `src/routes/api/status/+server.ts`**
   - Call `bot.getStatus()` directly, no proxy

### Root / Shared
1. **Update `docker-compose.yml`**
   - Single service `web` (or rename to `app`)
   - Web container now also needs: `GROQ_API_KEY`, `DATABASE_URL`, `DATABASE_PASSWORD`, `ALLOWED_PHONE`, `DEBUG`
   - Expose ports: `${WEB_PORT:-3000}:3000`
   - Volume: `./data:/data`
   - Remove `worker` service and `WORKER_API_URL` env
2. **Update `packages/web/Dockerfile`**
   - Copy `whatsapp-worker` source + build it before `build:web`
   - In runner stage, copy `packages/whatsapp-worker/dist`
3. **Update root `package.json` scripts**
   - Remove `dev:worker` or change it to a standalone bot mode
   - `start`: still `docker compose up -d`
4. **Update `.env.example`**
   - Remove `WORKER_API_URL`, `WORKER_PORT`

### Not Changing
- `baileys-connection.manager.ts`, `signal-key-store.ts`, `groq-client.ts`, `audio-handler.ts` (pure library code, zero HTTP)
- UI Svelte components (`+page.svelte`, `qr/+page.svelte`)
- Shared DB schema

## Verification Steps
1. Build worker → `tsup` produces `dist/index.mjs` + `dist/main.mjs`
2. Build web → imports `@chepibe-personal/whatsapp-worker` resolve correctly
3. Docker build for single service succeeds
4. No files import `http` in worker package except `main.ts`
5. Zero remaining references to `WORKER_API_URL`
6. No type errors on changed files
7. `docker-compose up --build` starts one container on port 3000, QR and status work
