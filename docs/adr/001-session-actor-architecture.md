# ADR-001: SessionActor Architecture for WhatsApp Worker

**Status**: Accepted (simplified May 2026)
**Date**: 2026-05-08
**Author**: Sisyphus

> **Update May 2026**: The architecture described here was implemented successfully but the deep domain/infrastructure nesting was later flattened into flat `src/` files for simplicity. The core concepts — Mutex-per-session, state machine validation, per-session ownership, Result types — remain intact. Class names changed: `SessionActor` → `WhatsAppSession`, `SingleSessionManager` + `ChepibeBot` → `ChepibeBot` (merged). See `docs/arquitectura.md` for current structure.

## Context

`chepibe-personal` is the primary WhatsApp worker for personal bots, published as `@chepibe-personal/whatsapp-worker`. It can be consumed by any application that needs a lightweight, self-hosted WhatsApp bot.

**Current architecture** (at time of writing):
Single-process, monolithic `BaileysConnectionManager` — an 897-line god class inside the worker package that manages all session state in shared global `Map` structures. Key issues:

1. **No concurrency safety** — Multiple operations (connect, reconnect, message handling) mutate shared Maps without synchronization.
2. **Stringly-typed state** — Session status is a raw string (`'none' | 'pending' | ...`) with no transition validation.
3. **Ad-hoc promise lifecycle** — `hasResolved` boolean flags guard promise resolution, making cleanup and error handling fragile.
4. **Scattered event handlers** — Multiple `socket.ev.on()` calls handle WhatsApp events independently, causing interleaving bugs.
5. **Silent error swallowing** — `AudioHandler` and `GroqClient` catch-and-log errors without propagating them.
6. **Key store flush races** — `SqliteKeyStore` uses an `isFlushing` flag pattern that loses writes under concurrent load.

## Decision

**Replace the 897-line `BaileysConnectionManager` with isolated `WhatsAppSession` instances managed directly by `ChepibeBot`.**

### Architecture

```
┌──────────────────────────────────┐
│         ChepibeBot               │
│  (EventEmitter, heartbeat,       │
│   mutex, factory)                │
│                                  │
│         WhatsAppSession          │
│                                  │
│  Mutex        StateMachine       │
│  Socket       SignalKeyStore     │
│  Dedup cache  AbortController    │
└──────────────────────────────────┘
```

**Key design principles**:

1. **Per-session ownership** — All state (socket, key store, reconnect attempts, dedup cache) lives _inside_ the session. No shared mutable Maps.
2. **Mutex guards all mutations** — `lock.runExclusive()` serializes concurrent operations (connect during reconnect, message during teardown).
3. **State machine validates transitions** — `SessionStateMachine` rejects invalid state changes (e.g., `destroyed → connected`).
4. **AbortController replaces `hasResolved`** — Clean cancellation of pending operations (QR wait, pairing wait) without boolean flag coordination.
5. **Event sink pattern** — Sessions push typed `SessionEvent` objects through a callback; no internal EventEmitter spaghetti.
6. **Result type for fallible operations** — `Result<T, E>` makes error paths explicit without throw/catch overhead.

## Consequences

### Positive

- **Thread safety**: Mutex prevents concurrent state mutations. No more race conditions.
- **Testability**: 61 unit tests covering state machine, key store, and session manager.
- **Memory safety**: `destroy()` calls `socket.end()`, clears all handlers and timers.
- **Observability**: Every state transition is logged with context (sessionId, from, to, duration).
- **Graceful shutdown**: `SIGTERM` handler stops all actors cleanly before exit.
- **Error propagation**: Errors propagate with `cause` chain, replacing silent catch-and-log patterns.
- **Simple codebase**: Flat file structure, no unnecessary layers. Easy to onboard.

### Negative

- **Mutex discipline required**: Deadlocks possible if `runExclusive` is called inside another `runExclusive`. Only acquire at entry points.
- **Single session model**: `ChepibeBot` is hardcoded to one session. Multi-session would require refactoring back to a session-manager pattern.

## References

- [Baileys Documentation](https://github.com/WhiskeySockets/Baileys)
- [async-mutex](https://github.com/DirtyHairy/async-mutex)
- Source: `packages/whatsapp-worker/src/` — all referenced source files
