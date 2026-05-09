# ADR-001: SessionActor Architecture for WhatsApp Worker

**Status**: Proposed  
**Date**: 2026-05-08  
**Author**: Sisyphus  

## Context

`chepibe-personal` is the primary WhatsApp worker for personal bots, published as `@chepibe-personal/whatsapp-worker`. It can be consumed by any application that needs a lightweight, self-hosted WhatsApp bot.

**Current architecture**:  
Single-process, monolithic `BaileysConnectionManager` — an 897-line god class inside the worker package that manages all session state in shared global `Map` structures. Key issues:

1. **No concurrency safety** — Multiple operations (connect, reconnect, message handling) mutate shared Maps without synchronization.
2. **Stringly-typed state** — Session status is a raw string (`'none' | 'pending' | ...`) with no transition validation.
3. **Ad-hoc promise lifecycle** — `hasResolved` boolean flags guard promise resolution, making cleanup and error handling fragile.
4. **Scattered event handlers** — Multiple `socket.ev.on()` calls handle WhatsApp events independently, causing interleaving bugs.
5. **Silent error swallowing** — `AudioHandler` and `GroqClient` catch-and-log errors without propagating them.
6. **Key store flush races** — `SqliteKeyStore` uses an `isFlushing` flag pattern that loses writes under concurrent load.

**Current package structure**:
```
packages/whatsapp-worker/src/
├── domain/
│   ├── session-actor.ts
│   ├── session-state-machine.ts
│   └── session-lock.ts
├── infrastructure/whatsapp/
│   ├── baileys-connection.manager.ts  (897 lines — to be deleted)
│   ├── signal-key-store.ts           (262 lines)
│   └── socket-manager.ts
├── chepibe-bot/
│   ├── chepibe-bot.ts                (orchestrator)
│   ├── chepibe-bot-options.ts
│   └── qr-result.ts
├── types/
│   ├── baileys-session.ts
│   ├── disconnect-reason.ts
│   ├── result.ts
│   ├── session-events.ts
│   ├── session-status.ts
│   └── transcription-result.ts
├── groq/
│   └── audio-handler.ts
├── constants/
├── main.ts
└── index.ts
```

**Current consumers**:
- `packages/web/src/lib/server/bot.ts` — web app bot singleton
- `packages/bot-manager/src/bot-pool.ts` — via npm dependency

## Decision

**Replace the 897-line `BaileysConnectionManager` with isolated `SessionActor` instances managed by a thin `SocketManager` routing layer.**

### Architecture

```
                  ┌─────────────────────────┐
                  │     SocketManager        │
                  │  Map<id, SessionActor>   │  ← Routing only. No state mutation.
                  └──────────┬──────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
       │ SessionActor │ │SessionActor│ │ SessionActor │
       │   session-1  │ │ session-2 │ │  session-3  │
       │              │ │           │ │             │
       │ Mutex        │ │ Mutex     │ │ Mutex       │
       │ StateMachine │ │ StateMachine│ │ StateMachine│
       │ Socket       │ │ Socket    │ │ Socket      │
       │ KeyStore     │ │ KeyStore  │ │ KeyStore    │
       │ Dedup cache  │ │ Dedup cache│ │ Dedup cache│
       │ AbortCtrl    │ │ AbortCtrl │ │ AbortCtrl   │
       └──────────────┘ └───────────┘ └─────────────┘
```

**Key design principles**:

1. **Per-session ownership** — All state (socket, key store, reconnect attempts, dedup cache) lives *inside* the actor. No shared mutable Maps across sessions.
2. **Mutex guards all mutations** — `lock.runExclusive()` serializes concurrent operations (connect during reconnect, message during teardown).
3. **State machine validates transitions** — `SessionStateMachine` rejects invalid state changes (e.g., `destroyed → connected`).
4. **AbortController replaces `hasResolved`** — Clean cancellation of pending operations (QR wait, pairing wait) without boolean flag coordination.
5. **One `ev.process()` per socket** — Serial event processing via Baileys' `ev.process()` instead of multiple `ev.on()` handlers.
6. **Event sink pattern** — Actors push typed `SessionEvent` objects through a callback; no internal EventEmitter spaghetti.
7. **Result type for fallible operations** — `Result<T, E>` makes error paths explicit without throw/catch overhead.

### Core Abstractions

#### `SessionStateMachine`

```typescript
type SessionStatus = 'none' | 'pending' | 'connected' | 'reconnecting' | 'destroyed';

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
    none:         ['pending'],
    pending:      ['connected', 'reconnecting', 'destroyed'],
    connected:    ['reconnecting', 'destroyed'],
    reconnecting: ['connected', 'reconnecting', 'destroyed'],
    destroyed:    [],
};

class SessionStateMachine {
    transition(to: SessionStatus, context: string): Result<void, TransitionError>;
    canTransition(to: SessionStatus): boolean;
    getState(): SessionStatus;
    getLog(): readonly TransitionRecord[];
    onTransition(listener: TransitionListener): () => void;  // returns unsubscribe
}
```

#### `SessionActor`

```typescript
class SessionActor {
    readonly sessionId: string;
    
    // Lifecycle
    async startQR(): Promise<Result<{ qrCode: string }, Error>>;
    async startPairing(phoneNumber: string): Promise<Result<{ code: string }, Error>>;
    async reconnect(): Promise<Result<void, Error>>;
    async stop(reason?: string): Promise<Result<void, Error>>;
    
    // Health
    isResponsive(): boolean;
    getStatus(): SessionStatus;
    getPhoneNumber(): string | null;
}
```

Internal state (all private, guarded by Mutex):
- `socket: WASocket | null`
- `stateMachine: SessionStateMachine`
- `lock: SessionLock` — Mutex wrapper with holder tracking
- `keyStore: SqliteKeyStore`
- `reconnectAttempts: number`
- `processedMessages: NodeCache` — per-session dedup, not shared
- `lidToPhoneCache: Map<string, string>` — per-session LID resolution
- `abortController: AbortController | null`

#### `SocketManager`

```typescript
class SocketManager {
    private actors = new Map<string, SessionActor>();
    
    async startSession(sessionId: string): Promise<Result<SessionActor, Error>>;
    async startPairing(sessionId: string, phoneNumber: string): Promise<Result<string, Error>>;
    async stopSession(sessionId: string, reason?: string): Promise<Result<void, Error>>;
    async restoreSessions(): Promise<void>;  // reconnects persisted sessions on boot
    getSession(sessionId: string): SessionActor | undefined;
    async destroy(): Promise<void>;
    startHeartbeat(intervalMs?: number): void;
}
```

`SocketManager` is a thin routing layer. It creates `SessionActor` instances via a factory and delegates ALL state decisions to the actor. The only shared map is `actors` itself (actor references, not state).

## Consequences

### Positive

- **Thread safety**: Mutex prevents concurrent state mutations. No more race conditions.
- **Testability**: `MockWASocket` enables unit testing the full `SessionActor` lifecycle without a real WhatsApp connection.
- **Memory safety**: `stop()` calls `socket.end()`, clears all handlers and timers, and removes the actor from the manager's map.
- **Observability**: Every state transition is logged with context (sessionId, from, to, duration). `healthcheck` endpoint reports actor responsiveness.
- **Graceful shutdown**: `SIGTERM` handler stops all actors cleanly before exit.
- **Error propagation**: `AudioProcessingError` with `cause` chain replaces silent catch-and-log patterns.

### Negative

- **Increased abstraction**: ~5 new files spread across `domain/` and `types/` before the old code is deleted. More surface area to learn.
- **Mutex discipline required**: Deadlocks possible if `runExclusive` is called inside another `runExclusive`. Only acquire at entry points.
- **ev.process() blocking**: A slow handler blocks all events for that session. Fast handlers must be maintained; heavy work (audio processing) deferred.

### Neutral

- `ChepibeBot` becomes a thin wrapper around `SocketManager`, emitting typed `SessionEvent` objects. The public API surface remains similar but events become type-safe.
- The `web` package consumer (`packages/web/src/lib/server/bot.ts`) must be updated to use the new typed event API.

## Implementation Plan

### Phase 1: Stabilize (1-2 weeks)

**Goal**: Fix structural problems in the existing code without changing architecture.

| Task | Effort | Key File(s) |
|------|--------|-------------|
| Add `async-mutex` and guard all session operations | 2 hours | `baileys-connection.manager.ts` |
| Extract `SessionStateMachine` with 100% transition coverage | 2 hours | `domain/session-state-machine.ts` |
| Replace `hasResolved` flags with `AbortController` | 1 hour | `baileys-connection.manager.ts` |
| Switch from `ev.on()` to `ev.process()` | 1 hour | `baileys-connection.manager.ts` |
| Fix `SqliteKeyStore` flush races (queue + flush promise) | 3 hours | `infrastructure/whatsapp/signal-key-store.ts` |
| Stop swallowing errors in audio/transcription pipeline | 1 hour | `groq/audio-handler.ts` |
| Extract `DisconnectReason` enum (remove magic numbers 515, 401) | 30 min | `types/disconnect-reason.ts` |
| Create `Result<T, E>` type | 30 min | `types/result.ts` |
| Create typed `SessionEvent` discriminated union | 30 min | `types/session-events.ts` |
| Create `SessionLock` (Mutex wrapper with holder tracking) | 30 min | `domain/session-lock.ts` |

**Phase 1 Deliverables**:
- All session operations guarded by Mutex
- Zero `hasResolved` flags
- One `ev.process()` per socket
- `SessionStateMachine` test suite (100% transition coverage)
- Zero silent error swallowing in audio/transcription pipeline
- `SqliteKeyStore` flush race fixed
- No magic numbers (`515`, `401`) in connection code

### Phase 2: Extract SessionActor (2-3 weeks)

**Goal**: Replace `BaileysConnectionManager` with `SessionActor` + `SocketManager`.

| Task | Effort | Key File(s) |
|------|--------|-------------|
| Implement `SessionActor` core (all lifecycle, event processing) | 1.5 days | `domain/session-actor.ts` |
| Write `SessionActor` unit tests (16+ scenarios with `MockWASocket`) | 1 day | `domain/session-actor.test.ts` |
| Implement `SocketManager` (thin routing layer) | 3 hours | `infrastructure/whatsapp/socket-manager.ts` |
| Refactor `ChepibeBot` to use `SocketManager` + `SessionActor` | 1 day | `chepibe-bot/chepibe-bot.ts` |
| Update `packages/web` consumer (`bot.ts`) for typed event API | 2 hours | `packages/web/src/lib/server/bot.ts` |
| Delete `BaileysConnectionManager` (only after verification) | 15 min | `infrastructure/whatsapp/baileys-connection.manager.ts` |

**Test scenarios for `SessionActor`** (all using `MockWASocket`):
1. `startQR()` → emits QR → resolves with qrCode
2. `startQR()` → timeout before QR → session destroyed
3. `startPairing()` → emits pairing code → resolves
4. `startPairing()` → timeout → session destroyed
5. Connection open → phone mismatch → teardown with data deletion
6. Connection open → valid phone → state: connected
7. Connection close → status code 515 → auto-reconnect
8. Connection close → status code 401 → permanent disconnect, data deleted
9. Connection close → recoverable → exponential backoff
10. Connection close → max retries → session destroyed
11. Incoming audio message from self → process and reply
12. Incoming audio message from other user → process with sender info
13. Duplicate message dedup → skip
14. `stop()` → cleans up socket, keyStore, all timers
15. Concurrent `startQR()` calls → only one socket created
16. `ev.process()` — sequential event processing, no interleaving

**Phase 2 Deliverables**:
- `BaileysConnectionManager` deleted
- Each `SessionActor` fully isolated (own socket, own state, own dedup cache)
- `MockWASocket` enables unit testing without real WhatsApp
- `ChepibeBot` is a thin event-emitting wrapper
- Web consumer updated and verified

### Phase 3: Observability & Production Hardening (1 week)

| Task | Effort |
|------|--------|
| Structured logging for every state transition (sessionId, from, to, context, duration) | 2 hours |
| Add `/health` endpoint (checks all actors are responsive) | 1 hour |
| Graceful shutdown via `SIGTERM` (stop all actors, destroy DB, exit) | 1 hour |
| Integration tests: full lifecycle with real WhatsApp staging account | 1 day |
| Stress tests: concurrent sessions, rapid reconnect cycles, 100+ messages | 4 hours |
| `SqliteKeyStore` flush stress test (1000 concurrent sets, parallel flushes) | 2 hours |
| `SessionActor` stress test (no deadlocks, no memory leaks under load) | 4 hours |

### Total Effort

| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 1: Stabilize | 1-2 weeks | Mutex, state machine, `ev.process()`, error propagation |
| Phase 2: Session Actor | 2-3 weeks | Extract actor, delete god object, comprehensive tests |
| Phase 3: Observability | 1 week | Logging, metrics, health, graceful shutdown, stress tests |
| **Total** | **4-6 weeks** | |

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mutex causes deadlocks if nested incorrectly | High — blocks all operations for a session | Only acquire lock at entry points; never call `runExclusive` inside `runExclusive`; stress test (T5.3) |
| `ev.process()` blocks under load (slow handler blocks all events) | Medium — connection events delayed by message processing | Keep handlers fast; move heavy work (audio processing) to background queue within same lock |
| `SessionActor` memory leak after many reconnects | Medium — leaked sockets and handlers accumulate | `stop()` must call `socket.end()`, clear all handlers, delete from `actors` map |
| `MockWASocket` doesn't match real Baileys behavior | Medium — tests pass but prod fails | Add integration tests against staging account with real WhatsApp; manual QA before merge |
| Breaking `packages/web/src/lib/server/bot.ts` consumer | Medium — web UI breaks | Update consumer in Phase 2; manual QA verification in Phase 3 |
| `SqliteKeyStore` data loss on crash | Medium — unrecoverable session state | Flush threshold lowered; proper queue recovery on error; crash recovery tests |

## Alternatives Considered

### Keep `BaileysConnectionManager` and add incremental fixes

**Rejected**: The shared-Map architecture is fundamentally unsound for multi-session operation. Adding mutexes and state machines to the existing god class would increase complexity without solving the root cause (shared mutable state). The refactor to isolated actors is the correct decomposition.

### Use a distributed state store (Redis) for session coordination

**Rejected**: `chepibe-personal` is a single-process application. Distributed coordination adds operational complexity (Redis dependency, network partitions, stale caches) with no benefit for the single-process use case.

## References

- [Baileys Documentation](https://github.com/WhiskeySockets/Baileys) — `ev.process()` API and best practices
- [async-mutex](https://github.com/DirtyHairy/async-mutex) — Mutex implementation used for session locking
- Source: `packages/whatsapp-worker/src/` — all referenced source files
