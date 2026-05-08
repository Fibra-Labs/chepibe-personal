# WhatsApp Infrastructure Redesign — Parallel Task Graph

## Overview

Full architecture redesign for WhatsApp across `chepibe-personal` and `chepibe` repos, going straight to the end-state. No incremental stabilization — we build the target architecture directly.

### Target Architecture

**`chepibe-personal` (single-process)**:
- `SessionActor` per session (owns: Mutex, StateMachine, Socket, KeyStore, dedup cache)
- `SocketManager` holds `Map<string, SessionActor>` — routing only, no state mutation
- `ev.process()` instead of `ev.on()` — serial event processing per session
- No shared mutable Maps — all state lives inside the actor
- `ChepibeBot` becomes thin wrapper around `SocketManager`

**`chepibe` (two-process)**:
- Worker: `SessionActor` + `SocketManager` (same as personal)
- Worker becomes stateless socket proxy — only connects sockets, emits raw events
- `core-api` owns all business logic, DB, audio processing
- Remove Redis PubSub state synchronization
- Remove duplicate caches

**Both repos**:
- Comprehensive tests using `chepibe-whatsapp-simulator`
- `MockWASocket` for unit tests
- All state transitions validated by `SessionStateMachine`

---

## Wave 0: Setup & Dependencies

### T0.1 — Create feature branches
**Repo**: both repos
**Effort**: 10 min
**Files**:
- `chepibe-personal`: branch `feat/session-actor` from `main`
- `chepibe`: branch `feat/session-actor` from `main`
- `chepibe-whatsapp-simulator`: branch `feat/mock-socket` from `main`

**Verification**: Both branches exist, CI green on base

### T0.2 — Install `async-mutex` in both repos
**Repo**: both
**Effort**: 5 min
**Files**:
- `chepibe-personal/packages/whatsapp-worker/package.json` — add `async-mutex`
- `chepibe/packages/whatsapp-worker/package.json` — add `async-mutex`

**Dependencies**: T0.1
**Verification**: `pnpm install` succeeds, `import { Mutex } from 'async-mutex'` resolves

### T0.3 — Simulator: expose `MockWASocket` factory
**Repo**: `chepibe-whatsapp-simulator`
**Effort**: 1 day
**Files**:
- `src/adapter/mock-socket.js` — NEW: creates a MockWASocket that implements `Pick<WASocket, 'ev' | 'end' | 'sendMessage' | 'sendPresenceUpdate' | 'requestPairingCode' | 'user'>` using Node EventEmitter
- `src/adapter/index.js` — export `createMockWASocket`
- `src/adapter/mock-auth-state.js` — NEW: in-memory auth state (no DB, no WebSocket) for unit tests
- `package.json` — bump version, add `exports` map for ESM+CJS

**What MockWASocket must support**:
```typescript
interface MockWASocket {
  ev: EventEmitter; // supports: connection.update, messages.upsert, creds.update
  user: { id: string; name: string } | undefined;
  sendMessage(jid: string, content: any): Promise<{ key: { id: string } }>;
  sendPresenceUpdate(type: string, jid: string): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
  end(reason?: any): Promise<void>;
  // Test helpers
  simulateOpen(phoneNumber: string): void;
  simulateClose(statusCode: number, error?: Error): void;
  simulateMessage(msg: WAMessage, type?: string): void;
  simulateQR(qr: string): void;
}
```

**Dependencies**: T0.1
**Verification**: `node --test tests/mock-socket.test.js` passes; MockWASocket can emit connection.update, messages.upsert, creds.update

### T0.4 — Simulator: add TypeScript declarations
**Repo**: `chepibe-whatsapp-simulator`
**Effort**: 3 hours
**Files**:
- `src/adapter/mock-socket.d.ts` — NEW: TypeScript declarations for MockWASocket
- `src/adapter/index.d.ts` — NEW: TypeScript declarations for exports
- `package.json` — add `types` field

**Dependencies**: T0.3
**Verification**: TypeScript consumers can `import { createMockWASocket } from 'chepibe-whatsapp-simulator'` without type errors

### T0.5 — Add simulator as devDependency in both repos
**Repo**: both
**Effort**: 15 min
**Files**:
- `chepibe-personal/packages/whatsapp-worker/package.json` — add `"chepibe-whatsapp-simulator": "workspace:*"` or git dep
- `chepibe/packages/whatsapp-worker/package.json` — same

**Dependencies**: T0.3, T0.4
**Verification**: `pnpm install` succeeds, simulator imports resolve

---

## Wave 1: Core Abstractions (Parallel)

These tasks have no dependencies on each other.

### T1.1 — `Result<T, E>` type
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 30 min
**Files**:
- `src/types/result.ts` — NEW

```typescript
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export namespace Result {
  export function ok<T>(value: T): Result<T, never> { return { ok: true, value }; }
  export function err<E>(error: E): Result<never, E> { return { ok: false, error }; }
  export function tryCatch<T>(fn: () => T): Result<T, Error>;
  export function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>>;
}
```

**Verification**: Unit tests pass for `Result.ok`, `Result.err`, pattern matching

### T1.2 — `SessionStateMachine`
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 2 hours
**Files**:
- `src/domain/session-state-machine.ts` — NEW
- `src/domain/session-state-machine.test.ts` — NEW

```typescript
type SessionStatus = 'none' | 'pending' | 'connected' | 'reconnecting' | 'destroyed';

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  none: ['pending'],
  pending: ['connected', 'reconnecting', 'destroyed'],
  connected: ['reconnecting', 'destroyed'],
  reconnecting: ['connected', 'reconnecting', 'destroyed'],
  destroyed: [],
};

export class SessionStateMachine {
  private state: SessionStatus = 'none';
  private readonly log: TransitionRecord[] = [];
  private readonly listeners: TransitionListener[] = [];

  transition(to: SessionStatus, context: string): Result<void, TransitionError>;
  canTransition(to: SessionStatus): boolean;
  getState(): SessionStatus;
  getLog(): readonly TransitionRecord[];
  onTransition(listener: TransitionListener): () => void;
}
```

**Test coverage required**:
- Valid transitions: none→pending, pending→connected, connected→reconnecting, reconnecting→connected
- Invalid transitions: none→connected, destroyed→pending, connected→none
- Transition logging and context tracking
- Listener notification on transitions

**Verification**: 100% transition coverage, all invalid transitions throw

### T1.3 — `Mutex` wrapper with lock metadata
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 30 min
**Files**:
- `src/domain/session-lock.ts` — NEW

```typescript
import { Mutex, E_TIMEOUT } from 'async-mutex';

export class SessionLock {
  private readonly mutex = new Mutex();
  private readonly sessionId: string;
  private holder: string | null = null;

  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T>;
  isLocked(): boolean;
  getHolder(): string | null;
}
```

**Verification**: Unit test that concurrent calls are serialized, label tracking works

### T1.4 — `SessionScope` type
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 30 min
**Files**:
- `src/types/session-scope.ts` — NEW

```typescript
export interface SessionScope {
  readonly sessionId: string;
  readonly phoneNumber: string;
  readonly stateMachine: SessionStateMachine;
  readonly lock: SessionLock;
  readonly keyStore: SqliteKeyStore;
  readonly startTime: Date;
  lastActivityAt: Date;
}
```

**Dependencies**: T1.2, T1.3
**Verification**: Type compiles, no runtime behavior to test

### T1.5 — Extract `DisconnectReason` enum
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 15 min
**Files**:
- `src/types/disconnect-reason.ts` — NEW

```typescript
export enum DisconnectReason {
  RESTART_REQUIRED = 515,
  LOGGED_OUT = 401,
  TIMED_OUT = 'timeout',
  PHONE_MISMATCH = 'phone_mismatch',
  INVALID_SESSION = 'invalid_session',
  MAX_RETRIES = 'max_retries',
  QR_TIMEOUT = 'qr_timeout',
  PAIRING_TIMEOUT = 'pairing_timeout',
}
```

Replace all magic numbers (`515`, `401`) and magic strings in `baileys-connection.manager.ts`.

**Verification**: `grep -r "515\|401" packages/whatsapp-worker/src/` returns no results after refactor

### T1.6 — Extract `SessionEvent` typed events
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 30 min
**Files**:
- `src/types/session-events.ts` — NEW

```typescript
export type SessionEvent =
  | { type: 'QR_READY'; sessionId: string; qrCode: string }
  | { type: 'CONNECTED'; sessionId: string; phoneNumber: string }
  | { type: 'DISCONNECTED'; sessionId: string; reason: string }
  | { type: 'RECOVERABLE_DISCONNECT'; sessionId: string; reason: string; statusCode: number }
  | { type: 'PERMANENT_DISCONNECT'; sessionId: string; reason: string; statusCode: number }
  | { type: 'AUDIO_PROCESSING_FAILED'; sessionId: string; messageId: string; error: Error };
```

Replace the stringly-typed `EventEmitter.on('QR_READY', ...)` calls.

**Verification**: All `eventEmitter.on(string, ...)` calls use `SessionEvent['type']`

---

## Wave 2: SessionActor + SocketManager (Sequential within, Parallel across repos)

### T2.1 — `SessionActor` core implementation
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 1.5 days
**Files**:
- `src/domain/session-actor.ts` — NEW (the heart of the redesign)

This is the single most critical file. It replaces ALL logic currently in `BaileysConnectionManager` that touches per-session state.

```typescript
export class SessionActor {
  readonly sessionId: string;
  private phoneNumber: string | null = null;
  private socket: WASocket | null = null;
  private readonly stateMachine: SessionStateMachine;
  private readonly lock: SessionLock;
  private readonly keyStore: SqliteKeyStore;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private processedMessages: NodeCache;
  private readonly lidToPhoneCache = new Map<string, string>();
  private abortController: AbortController | null = null;

  constructor(
    sessionId: string,
    private readonly db: Db,
    private readonly client: Client,
    private readonly audioHandler: AudioHandler,
    private readonly logger: Logger,
    private readonly allowedPhone: string,
    private readonly eventSink: (event: SessionEvent) => void,
  ) {}

  // --- Lifecycle ---
  async startQR(): Promise<Result<{ qrCode: string }, Error>>;
  async startPairing(phoneNumber: string): Promise<Result<{ code: string }, Error>>;
  async reconnect(): Promise<Result<void, Error>>;
  async stop(reason?: string): Promise<Result<void, Error>>;

  // --- Event processing (ev.process) ---
  private async processEvents(events: BaileysEventMap): Promise<void>;

  // --- Internal ---
  private async handleConnectionOpen(): Promise<Result<void, Error>>;
  private async handleConnectionClose(update: any): Promise<Result<void, Error>>;
  private async handleMessage(m: any): Promise<void>;
  private async loadOrCreateAuthState(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  private async teardown(deleteData: boolean, reason?: string): Promise<void>;
  private async validateSession(): Promise<boolean>;

  // --- Health ---
  isResponsive(): boolean;
  getStatus(): SessionStatus;
  getPhoneNumber(): string | null;
}
```

**Key design principles**:
1. `lock.runExclusive()` guards ALL state mutations
2. `stateMachine.transition()` called at every state change
3. `abortController` replaces `hasResolved` flags
4. `ev.process()` used instead of multiple `ev.on()` handlers
5. All events pushed through `eventSink` callback — no internal EventEmitter
6. `processedMessages` and `lidToPhoneCache` are per-actor, not shared across sessions

**Dependencies**: T1.1 (Result), T1.2 (SessionStateMachine), T1.4 (SessionScope), T1.5 (DisconnectReason), T1.6 (SessionEvent)
**Verification**: Unit tests with MockWASocket covering: start→QR→connected, start→pairing→connected, reconnect after 515, logged out (401), max retries exceeded

### T2.2 — `SessionActor` unit tests
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 1 day
**Files**:
- `src/domain/session-actor.test.ts` — NEW

**Test scenarios** (all using `MockWASocket`):
1. `startQR()` → emits QR → resolves with qrCode
2. `startQR()` → timeout before QR → rejects with error, session destroyed
3. `startPairing()` → emits pairing code → resolves
4. `startPairing()` → timeout → rejects, session destroyed
5. `handleConnectionOpen()` → phone mismatch → teardown with deleteData
6. `handleConnectionOpen()` → valid phone → state: connected
7. `handleConnectionClose()` → 515 → auto-reconnect
8. `handleConnectionClose()` → 401 → permanent disconnect, data deleted
9. `handleConnectionClose()` → recoverable → exponential backoff
10. `handleConnectionClose()` → max retries → session destroyed
11. `handleMessage()` → audio from self → process and reply
12. `handleMessage()` → audio from other → process with sender info
13. `handleMessage()` → duplicate dedup → skip
14. `stop()` → cleans up socket, keyStore, timers
15. Concurrent `startQR()` calls → second returns existing QR (not creating duplicate socket)
16. `ev.process()` — sequential event processing, no interleaving

**Dependencies**: T2.1, T0.3 (MockWASocket)
**Verification**: All 16+ scenarios pass, 100% state transition coverage

### T2.3 — `SocketManager` implementation
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 3 hours
**Files**:
- `src/infrastructure/whatsapp/socket-manager.ts` — NEW

```typescript
export class SocketManager {
  private actors = new Map<string, SessionActor>();
  private readonly logger: Logger;

  constructor(
    private readonly sessionFactory: SessionActorFactory,
    logger: Logger,
  ) {}

  async startSession(sessionId: string): Promise<Result<SessionActor, Error>>;
  async startPairing(sessionId: string, phoneNumber: string): Promise<Result<string, Error>>;
  async stopSession(sessionId: string, reason?: string): Promise<Result<void, Error>>;
  async restoreSessions(): Promise<void>;
  getSession(sessionId: string): SessionActor | undefined;
  getSessions(): SessionActor[];
  async destroy(): Promise<void>;
  startHeartbeat(intervalMs?: number): void;
  stopHeartbeat(): void;
}
```

**Key design**: `SocketManager` is a thin routing layer. It creates `SessionActor` instances via a factory and delegates ALL state decisions to the actor. No shared Maps except the `actors` map itself.

**Dependencies**: T2.1
**Verification**: Unit test that SocketManager creates/destores actors correctly, delegates lifecycle calls

### T2.4 — Refactor `SqliteKeyStore` flush races
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 3 hours
**Files**:
- `src/infrastructure/whatsapp/signal-key-store.ts` — MODIFY
- `src/infrastructure/whatsapp/signal-key-store.test.ts` — MODIFY

Replace `isFlushing` flag pattern with proper queue + flush promise:

```typescript
class SqliteKeyStore implements SignalKeyStore {
  private queue: KeyMutation[] = [];
  private flushInProgress: Promise<void> | null = null;
  private readonly FLUSH_THRESHOLD = 50;
  private readonly FLUSH_INTERVAL_MS = 2000;

  async set(data: SignalDataSet): Promise<void> {
    // Queue mutation, then maybe flush
    for (const [type, values] of Object.entries(data)) {
      for (const [id, value] of Object.entries(values || {})) {
        const cacheKey = `${type}:${id}`;
        if (value !== null) {
          this.cache.set(cacheKey, value);
          this.queue.push({ type, id, value, operation: 'upsert' });
        } else {
          this.cache.delete(cacheKey);
          this.queue.push({ type, id, value: null, operation: 'delete' });
        }
      }
    }
    if (this.queue.length >= this.FLUSH_THRESHOLD) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress) {
      await this.flushInProgress; // Wait for existing flush
      if (this.queue.length === 0) return;
    }
    this.flushInProgress = this.doFlush();
    try {
      await this.flushInProgress;
    } finally {
      this.flushInProgress = null;
    }
  }

  private async doFlush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    try {
      // Transactional batch write
      for (const m of batch) {
        if (m.operation === 'upsert') {
          await this.db.insert(whatsappSessionKeys).values({...}).onConflictDoUpdate({...});
        } else {
          await this.db.delete(whatsappSessionKeys).where(and(...));
        }
      }
    } catch (error) {
      this.queue.unshift(...batch);
      throw error;
    }
  }
}
```

**Dependencies**: None (can start immediately)
**Verification**: Existing tests pass; new test for concurrent flush calls shows no data loss; new test for error retry shows queue recovery

### T2.5 — Fix error swallowing in `AudioHandler` and `GroqClient`
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 1 hour
**Files**:
- `src/infrastructure/groq/audio-handler.ts` — MODIFY
- `src/domain/audio-processing-error.ts` — NEW

**Changes**:
- `AudioHandler.handleAudioMessage()` catch block: throw `AudioProcessingError` instead of silently logging
- `GroqClient.summarizeTranscription()` catch block: throw instead of returning empty string
- New `AudioProcessingError` extends `Error` with `cause` chain

**Dependencies**: None
**Verification**: Errors propagate upward, no silent catches

---

## Wave 3: Refactor `chepibe-personal` worker

### T3.1 — Replace `BaileysConnectionManager` with `SocketManager` + `SessionActor`
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 1 day
**Files**:
- `src/chepibe-bot/chepibe-bot.ts` — MODIFY (major: replace BaileysConnectionManager with SocketManager)
- `src/infrastructure/whatsapp/baileys-connection.manager.ts` — DELETE
- `src/index.ts` — MODIFY (update exports)

**What changes in `ChepibeBot`**:
```typescript
export class ChepibeBot extends EventEmitter {
  private socketManager: SocketManager | null = null;

  async start(): Promise<void> {
    // DB setup...
    this.socketManager = new SocketManager(
      (sessionId) => new SessionActor(sessionId, db, client, audioHandler, logger, allowedPhone, (event) => {
        this.emit(event.type, event);
      }),
      logger,
    );
    await this.socketManager.restoreSessions();
    this.socketManager.startHeartbeat(30000);
  }

  async getQR(sessionId?: string): Promise<QRResult> { ... }
  async requestPairingCode(sessionId: string, phoneNumber: string): Promise<{ code: string; sessionId: string }> { ... }
  async disconnect(sessionId: string): Promise<void> { ... }
  async destroy(): Promise<void> { ... }
}
```

**Critical**: `ChepibeBot` becomes a thin wrapper. All state management moves to `SessionActor`.

**Dependencies**: T2.1, T2.2, T2.3, T2.4, T2.5
**Verification**: Manual QA — start bot, scan QR, send voice message, verify transcription and reply

### T3.2 — Switch `ChepibeBot` from `EventEmitter.on(string)` to typed events
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 1 hour
**Files**:
- `src/chepibe-bot/chepibe-bot.ts` — MODIFY
- `src/types/session-events.ts` — already created in T1.6

Replace:
```typescript
// Before
connectionManager.on('QR_READY', (data) => { this.emit('QR_READY', data); });
// After
actor events pipe directly through eventSink callback → typed SessionEvent
```

**Dependencies**: T3.1, T1.6
**Verification**: Type-safe event handling, no stringly-typed events

### T3.3 — Update `packages/web` consumer (bot.ts)
**Repo**: `chepibe-personal` `packages/web/src/lib/server`
**Effort**: 2 hours
**Files**:
- `packages/web/src/lib/server/bot.ts` — MODIFY

Update to consume new `ChepibeBot` API with typed events. Verify QR scanning flow still works.

**Dependencies**: T3.1
**Verification**: Web UI can start bot, scan QR, see status updates

### T3.4 — Delete `BaileysConnectionManager`
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 15 min
**Files**:
- `src/infrastructure/whatsapp/baileys-connection.manager.ts` — DELETE

Only after T3.1, T3.2, T3.3 are verified.

**Dependencies**: T3.1, T3.2, T3.3
**Verification**: Build succeeds, no import references to deleted file

---

## Wave 4: Refactor `chepibe` worker + core-api

### T4.1 — Port core abstractions to `chepibe`
**Repo**: `chepibe` `packages/whatsapp-worker/src`
**Effort**: 3 hours
**Files**:
- `src/domain/session-state-machine.ts` — NEW (copy from chepibe-personal, adjust states)
- `src/domain/session-actor.ts` — NEW (adapt from chepibe-personal)
- `src/domain/session-lock.ts` — NEW
- `src/types/result.ts` — NEW
- `src/types/session-events.ts` — NEW
- `src/types/disconnect-reason.ts` — NEW

**Note**: `chepibe` has NestJS dependency injection. `SessionActor` needs NestJS-compatible factory injection.

**Dependencies**: T2.1, T2.2 (port from chepibe-personal once stable)
**Verification**: Unit tests pass (same scenarios as T2.2)

### T4.2 — Port `SqliteKeyStore` flush fix to `chepibe`
**Repo**: `chepibe` `packages/whatsapp-worker/src`
**Effort**: 2 hours
**Files**:
- `src/infrastructure/whatsapp/signal-key-store.ts` — MODIFY (same queue pattern as T2.4)

**Note**: `chepibe`'s SignalKeyStore is 341 lines (vs 262 in personal) — uses MikroORM instead of Drizzle.

**Dependencies**: T2.4
**Verification**: Existing tests pass; concurrent flush test passes

### T4.3 — Replace `BaileysConnectionManager` in `chepibe` worker
**Repo**: `chepibe` `packages/whatsapp-worker/src`
**Effort**: 2 days
**Files**:
- `src/infrastructure/whatsapp/socket-manager.ts` — NEW
- `src/infrastructure/whatsapp/session-actor.ts` — NEW (or `src/domain/session-actor.ts`)
- `src/infrastructure/whatsapp/baileys-connection.manager.ts` — DELETE (1429 lines)
- `src/infrastructure/whatsapp/disconnect-handler.ts` — DELETE (logic moved into SessionActor)
- `src/infrastructure/whatsapp/session-lock.manager.ts` — DELETE (replaced by per-session Mutex)
- `src/infrastructure/whatsapp/whatsapp.module.ts` — MODIFY (new providers)

**Key difference from personal**: `chepibe` worker publishes events via Redis PubSub (`PubSubService`). The `SessionActor.eventSink` must publish to Redis instead of just calling a local callback.

```typescript
// In chepibe's SessionActor constructor:
this.eventSink = (event: SessionEvent) => {
  this.pubSub.publish(event.type, event); // Redis publish
};
```

**Dependencies**: T4.1, T4.2
**Verification**: Worker can connect, publish events to Redis, core-api receives them

### T4.4 — Make worker a stateless socket proxy
**Repo**: `chepibe` `packages/whatsapp-worker/src`
**Effort**: 1 day
**Files**:
- `src/infrastructure/whatsapp/whatsapp.module.ts` — MODIFY
- `src/infrastructure/messaging/` — REWRITE (strip message processing, only raw event forwarding)
- Remove: audio processing, message dedup, LID resolution from worker

**The worker now only**:
1. Connects sockets (via `SessionActor`)
2. Publishes raw `messages.upsert` to Redis as `RAW_MESSAGE` events
3. Publishes raw `connection.update` to Redis as `CONNECTION_UPDATE` events
4. Receives `SEND_MESSAGE` commands from Redis, calls `socket.sendMessage()`
5. No DB writes, no audio processing, no Groq calls

**Dependencies**: T4.3
**Verification**: Worker boots, connects socket, publishes raw events. No business logic in worker.

### T4.5 — Move audio processing to `core-api`
**Repo**: `chepibe` `packages/core-api/src`
**Effort**: 1 day
**Files**:
- `packages/core-api/src/infrastructure/whatsapp/voice-message.processor.ts` — MODIFY (subscribe to `RAW_MESSAGE`, process audio, publish `SEND_MESSAGE` command)
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-connection.proxy.ts` — MODIFY (simplify: command pass-through with ack)
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.manager.ts` — REWRITE (DB-only, no local cache)
- `packages/core-api/src/infrastructure/whatsapp/whatsapp.module.ts` — MODIFY

**Dependencies**: T4.4
**Verification**: core-api processes audio messages end-to-end via Redis PubSub

### T4.6 — Remove duplicate caches
**Repo**: `chepibe` `packages/core-api/src`
**Effort**: 4 hours
**Files**:
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.manager.ts` — REWRITE (remove `localSessionCache`, Redis cache, DB is sole source of truth)
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.redis.ts` — DELETE
- `packages/core-api/src/infrastructure/redis/` — MODIFY (remove session-specific Redis keys)

**Dependencies**: T4.5
**Verification**: Only DB reads for session state, no local or Redis caches

### T4.7 — Delete `WhatsAppConnectionProxy` state caching
**Repo**: `chepibe` `packages/core-api/src`
**Effort**: 3 hours
**Files**:
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-connection.proxy.ts` — REWRITE (command pass-through only, no state)

The proxy becomes:
```typescript
class WhatsAppConnectionProxy {
  async sendCommand(command: WhatsappCommand): Promise<void> {
    await this.pubSub.publish(command.type, command.payload);
    const ack = await this.waitForAck(command.id, 5000);
    if (!ack) throw new TimeoutError('Worker did not acknowledge');
  }
}
```

**Dependencies**: T4.6
**Verification**: All API endpoints still work through simplified proxy

---

## Wave 5: Tests + Simulator Integration

### T5.1 — Integration test: full SessionActor lifecycle with simulator
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 1 day
**Files**:
- `src/domain/session-actor.integration.test.ts` — NEW

**Test scenarios** (using `chepibe-whatsapp-simulator`):
1. Start simulator → create SessionActor → connect → receive QR → scan → connected
2. Send voice message through simulator → audio processed → reply received
3. Disconnect simulator → reconnect → verify session restored
4. Kill simulator mid-session → reconnect with saved creds
5. Concurrent sessions (2 actors) → both process messages independently

**Dependencies**: T2.1, T0.3, T0.5
**Verification**: All integration scenarios pass against live simulator

### T5.2 — Integration test: `chepibe` worker + core-api via Redis
**Repo**: `chepibe` `packages/whatsapp-worker/src` + `packages/core-api/src`
**Effort**: 1 day
**Files**:
- `packages/whatsapp-worker/src/domain/session-actor.integration.test.ts` — NEW
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.manager.integration.test.ts` — NEW

**Test scenarios**:
1. Worker connects session → publishes `CONNECTION_UPDATE` to Redis → core-api receives
2. Worker receives raw message → publishes `RAW_MESSAGE` → core-api processes audio
3. core-api sends `SEND_MESSAGE` command → worker sends via socket → message delivered
4. Worker disconnect → publishes `PERMANENT_DISCONNECT` → core-api cleans up DB state

**Dependencies**: T4.5, T0.3, T0.5
**Verification**: End-to-end flow through Redis PubSub

### T5.3 — Stress test: concurrent session operations
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 4 hours
**Files**:
- `src/domain/session-actor.stress.test.ts` — NEW

**Test scenarios**:
1. 5 concurrent `startQR()` calls for same session → only one socket created
2. `stop()` called while `handleMessage()` is processing → clean shutdown
3. Rapid `reconnect()` → `disconnect()` → `reconnect()` → state consistent
4. 100 messages in quick succession → no lost messages, dedup works

**Dependencies**: T2.2, T5.1
**Verification**: No deadlocks, no race conditions, no memory leaks

### T5.4 — `SqliteKeyStore` flush stress test
**Repo**: `chepibe-personal` `packages/whatsapp-worker/src`
**Effort**: 2 hours
**Files**:
- `src/infrastructure/whatsapp/signal-key-store.stress.test.ts` — NEW

**Test scenarios**:
1. 1000 concurrent `set()` calls → all persisted after flush
2. Two `forceFlush()` calls in parallel → no double-flush, no data loss
3. `destroy()` called while `flush()` is in progress → all data persisted
4. DB error during flush → queue retains items, retry succeeds

**Dependencies**: T2.4
**Verification**: No data loss under concurrent load

---

## Wave 6: Verification & Cleanup

### T6.1 — Build verification: `chepibe-personal`
**Repo**: `chepibe-personal`
**Effort**: 30 min
**Verification**:
- `pnpm build` succeeds
- `pnpm test` all pass
- `pnpm typecheck` no errors
- No import references to deleted `baileys-connection.manager.ts`

### T6.2 — Build verification: `chepibe`
**Repo**: `chepibe`
**Effort**: 30 min
**Verification**:
- `pnpm build` succeeds
- Existing test suite passes
- No import references to deleted files

### T6.3 — Manual QA: `chepibe-personal`
**Repo**: `chepibe-personal`
**Effort**: 2 hours
**Checklist**:
1. Start bot → QR code displayed in web UI
2. Scan QR → session connects, status shows "connected"
3. Send voice message → transcription and summary received
4. Send voice from group → transcription with sender info
5. Disconnect internet → reconnect behavior
6. Restart bot → session restores from saved credentials
7. Request pairing code → works
8. Phone mismatch → session destroyed with error
9. Check logs: every state transition logged with context
10. Check DB: session status, keys persisted correctly

### T6.4 — Manual QA: `chepibe`
**Repo**: `chepibe`
**Effort**: 2 hours
**Checklist**:
1. Worker starts → connects to core-api via Redis
2. Create session → QR/pairing → connected
3. Send message → worker publishes to Redis → core-api processes
4. Receive voice → core-api processes via Groq → sends reply command → worker delivers
5. Kill worker → restart → sessions restore
6. Kill core-api → worker continues (socket maintained)
7. Restart core-api → reconnects to Redis → receives current state from DB

### T6.5 — Cleanup: remove dead code
**Repo**: both
**Effort**: 1 hour
**Files to DELETE in `chepibe-personal`**:
- `src/infrastructure/whatsapp/baileys-connection.manager.ts`
- `src/types/baileys-session.ts` (replaced by SessionActor's internal state)

**Files to DELETE in `chepibe`**:
- `packages/whatsapp-worker/src/infrastructure/whatsapp/baileys-connection.manager.ts`
- `packages/whatsapp-worker/src/infrastructure/whatsapp/disconnect-handler.ts`
- `packages/whatsapp-worker/src/infrastructure/whatsapp/session-lock.manager.ts`
- `packages/whatsapp-worker/src/infrastructure/whatsapp/whatsapp-auth-redis.ts` (if fully replaced)
- `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.redis.ts`
- `packages/core-api/src/infrastructure/whatsapp/baileys-simulator.service.ts` (real simulator replaces this)

**Dependencies**: T6.1, T6.2, T6.3, T6.4
**Verification**: Build still succeeds after deletion

---

## Task Dependency Graph

```
Wave 0 (Setup):
  T0.1 ──→ T0.2
  T0.1 ──→ T0.3 ──→ T0.4 ──→ T0.5

Wave 1 (Core Abstractions — ALL parallel):
  T1.1 ─────────────────────────────────────┐
  T1.2 ──────────────────────────────────────┤
  T1.3 ──────────────────────────────────────┤
  T1.5 ──────────────────────────────────────┤
  T1.6 ──────────────────────────────────────┤
  T1.4 ← (T1.2 + T1.3)                     │
                                             │
Wave 2 (SessionActor + SocketManager):        │
  T2.1 ← (T1.1 + T1.2 + T1.4 + T1.5 + T1.6)│
  T2.2 ← (T2.1 + T0.3)                      │
  T2.3 ← T2.1                               │
  T2.4 ───────── (independent) ──────────────┤
  T2.5 ───────── (independent) ──────────────┘

Wave 3 (Refactor chepibe-personal):
  T3.1 ← (T2.1 + T2.2 + T2.3 + T2.4 + T2.5)
  T3.2 ← (T3.1 + T1.6)
  T3.3 ← T3.1
  T3.4 ← (T3.1 + T3.2 + T3.3)

Wave 4 (Refactor chepibe — parallel with Wave 3):
  T4.1 ← (T2.1 + T2.2)
  T4.2 ← T2.4
  T4.3 ← (T4.1 + T4.2)
  T4.4 ← T4.3
  T4.5 ← T4.4
  T4.6 ← T4.5
  T4.7 ← T4.6

Wave 5 (Tests — starts as soon as Wave 2 done):
  T5.1 ← (T2.1 + T0.3 + T0.5)
  T5.2 ← (T4.5 + T0.3 + T0.5)
  T5.3 ← (T2.2 + T5.1)
  T5.4 ← T2.4

Wave 6 (Verification):
  T6.1 ← T3.4
  T6.2 ← T4.7
  T6.3 ← T6.1
  T6.4 ← T6.2
  T6.5 ← (T6.3 + T6.4)
```

---

## Parallel Execution Strategy

### Parallel Track A: `chepibe-personal` (lower risk, can complete first)
```
T0.1 → T0.2 → T0.3 → T0.4 → T0.5
                                    ↓
T1.1 ─┐                        (in parallel)
T1.2 ─┤
T1.3 ─┼──→ T1.4 ──┐
T1.5 ─┤              │
T1.6 ─┘              ↓
                 T2.1 → T2.2 → T2.3
                 T2.4 ──┐
                 T2.5 ──┘
                         ↓
                    T3.1 → T3.2 → T3.3 → T3.4
```

### Parallel Track B: `chepibe` (starts after Wave 2 is stable)
```
              T4.1 ←── (from Track A T2.1+T2.2)
              T4.2 ←── (from Track A T2.4)
                  ↓
              T4.3 → T4.4 → T4.5 → T4.6 → T4.7
```

### Testing Track (overlaps with both)
```
T5.1 ←── (Track A T2.1 + simulator)
T5.4 ←── (Track A T2.4)
T5.3 ←── (T5.1 + T2.2)
T5.2 ←── (Track B T4.5 + simulator)
```

---

## Effort Estimate

| Wave | Tasks | Total Effort | Critical Path |
|------|-------|-------------|---------------|
| Wave 0 | T0.1–T0.5 | ~1.5 days | T0.1→T0.3→T0.4→T0.5 |
| Wave 1 | T1.1–T1.6 | ~4 hours | All parallel, no critical path |
| Wave 2 | T2.1–T2.5 | ~3.5 days | T2.1 (1.5d) + T2.2 (1d) |
| Wave 3 | T3.1–T3.4 | ~1.5 days | T3.1 (1d) + T3.2 (1h) |
| Wave 4 | T4.1–T4.7 | ~5 days | T4.3(2d)→T4.4(1d)→T4.5(1d)→T4.6→T4.7 |
| Wave 5 | T5.1–T5.4 | ~2.5 days | Can start after T2.1 |
| Wave 6 | T6.1–T6.5 | ~1 day | After Waves 3+4 complete |
| **Total** | | **~18 days** (1 engineer) or **~10 days** (2 engineers) | |

### Two-Engineer Schedule

| Day | Engineer A (`chepibe-personal`) | Engineer B (`chepibe` + shared) |
|-----|----------------------------------|----------------------------------|
| D1 | T0.1, T0.2, T1.1, T1.3, T1.5 | T0.3 (MockWASocket), T0.4 |
| D2 | T1.2, T1.6, T1.4, T2.4, T2.5 | T0.5, T4.2 |
| D3 | T2.1 (SessionActor core) | T4.1 (port abstractions to chepibe) |
| D4 | T2.2 (SessionActor tests) | T4.1 continued |
| D5 | T2.3 (SocketManager) | T5.1 (integration tests with simulator) |
| D6 | T3.1 (replace ConnectionManager) | T4.3 (replace ConnectionManager in chepibe) |
| D7 | T3.2, T3.3 (typed events, web consumer) | T4.3 continued |
| D8 | T3.4 (delete god object), T5.4 (key store stress) | T4.4 (stateless proxy) |
| D9 | T5.3 (stress tests) | T4.5 (move audio to core-api) |
| D10 | T6.1, T6.3 (build + manual QA personal) | T4.6, T4.7 (remove caches, simplify proxy) |
| D11 | T5.2 (integration tests for chepibe) | T4.7 continued |
| D12 | T6.2, T6.4 (build + manual QA chepibe) | T6.5 (cleanup dead code) |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| `Mutex` deadlock in `SessionActor` | High — blocks all operations for a session | Only acquire at entry points; never nest `runExclusive`; test with `T5.3` |
| `ev.process()` blocks on slow handlers | Medium — connection events delayed by message processing | Keep handlers fast; defer audio processing to next tick if needed |
| `chepibe-whatsapp-simulator` doesn't match real Baileys | Medium — tests pass but prod fails | Keep manual QA (T6.3, T6.4); test against real WhatsApp before merge |
| Breaking `packages/web/bot.ts` consumer | Medium — web UI breaks | T3.3 specifically updates the consumer; manual QA in T6.3 |
| Redis PubSub message loss in `chepibe` | High — events lost between worker and core-api | Add acknowledgment layer in T4.7; test with T5.2 |
| `SqliteKeyStore` data loss on crash | Medium — unrecoverable session state | Flush threshold lowered from 1000 to 50; crash recovery in T2.4 |
| NestJS DI conflicts in `chepibe` worker | Low — SessionActor isn't a NestJS service | Use factory pattern; SessionActor created by SocketManager, not by DI |

---

## Files Created / Modified Summary

### `chepibe-personal` — NEW files
| File | Purpose |
|------|---------|
| `src/types/result.ts` | Result type |
| `src/types/session-scope.ts` | Session scope interface |
| `src/types/session-events.ts` | Typed session events |
| `src/types/disconnect-reason.ts` | Disconnect reason enum |
| `src/domain/session-state-machine.ts` | State machine |
| `src/domain/session-state-machine.test.ts` | State machine tests |
| `src/domain/session-actor.ts` | Session actor (THE core) |
| `src/domain/session-actor.test.ts` | Actor unit tests |
| `src/domain/session-actor.integration.test.ts` | Integration tests |
| `src/domain/session-actor.stress.test.ts` | Stress tests |
| `src/domain/session-lock.ts` | Mutex wrapper |
| `src/domain/audio-processing-error.ts` | Error type |
| `src/infrastructure/whatsapp/socket-manager.ts` | Socket manager |

### `chepibe-personal` — MODIFIED files
| File | Change |
|------|--------|
| `src/infrastructure/whatsapp/signal-key-store.ts` | Flush race fix |
| `src/infrastructure/whatsapp/signal-key-store.test.ts` | New flush stress tests |
| `src/infrastructure/whatsapp/signal-key-store.stress.test.ts` | Concurrent flush tests |
| `src/infrastructure/groq/audio-handler.ts` | Error propagation |
| `src/infrastructure/groq/groq-client.ts` | Error propagation |
| `src/chepibe-bot/chepibe-bot.ts` | Replace ConnectionManager with SocketManager |
| `src/chepibe-bot/chepibe-bot-options.ts` | Add eventSink option |
| `src/index.ts` | Update exports |
| `packages/web/src/lib/server/bot.ts` | Consume new API |

### `chepibe-personal` — DELETED files
| File | Reason |
|------|--------|
| `src/infrastructure/whatsapp/baileys-connection.manager.ts` | Replaced by SessionActor + SocketManager |

### `chepibe` — NEW files
| File | Purpose |
|------|---------|
| `packages/whatsapp-worker/src/domain/session-state-machine.ts` | State machine |
| `packages/whatsapp-worker/src/domain/session-actor.ts` | Session actor (with Redis PubSub) |
| `packages/whatsapp-worker/src/domain/session-lock.ts` | Mutex wrapper |
| `packages/whatsapp-worker/src/types/result.ts` | Result type |
| `packages/whatsapp-worker/src/types/session-events.ts` | Typed events |
| `packages/whatsapp-worker/src/types/disconnect-reason.ts` | Disconnect enum |
| `packages/whatsapp-worker/src/infrastructure/whatsapp/socket-manager.ts` | Socket manager |

### `chepibe` — MODIFIED files
| File | Change |
|------|--------|
| `packages/whatsapp-worker/src/infrastructure/whatsapp/signal-key-store.ts` | Flush race fix |
| `packages/whatsapp-worker/src/infrastructure/whatsapp/whatsapp.module.ts` | New providers |
| `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.manager.ts` | DB-only, no cache |
| `packages/core-api/src/infrastructure/whatsapp/whatsapp-connection.proxy.ts` | Command pass-through |
| `packages/core-api/src/infrastructure/whatsapp/voice-message.processor.ts` | Audio processing |
| `packages/core-api/src/infrastructure/whatsapp/whatsapp.module.ts` | Updated providers |

### `chepibe` — DELETED files
| File | Reason |
|------|--------|
| `packages/whatsapp-worker/src/infrastructure/whatsapp/baileys-connection.manager.ts` | Replaced by SessionActor |
| `packages/whatsapp-worker/src/infrastructure/whatsapp/disconnect-handler.ts` | Logic in SessionActor |
| `packages/whatsapp-worker/src/infrastructure/whatsapp/session-lock.manager.ts` | Replaced by per-session Mutex |
| `packages/core-api/src/infrastructure/whatsapp/whatsapp-session.redis.ts` | Removed Redis cache |

### `chepibe-whatsapp-simulator` — NEW files
| File | Purpose |
|------|--------|
| `src/adapter/mock-socket.js` | MockWASocket for unit tests |
| `src/adapter/mock-socket.d.ts` | TypeScript declarations |
| `src/adapter/mock-auth-state.js` | In-memory auth state for tests |
| `src/adapter/mock-auth-state.d.ts` | TypeScript declarations |