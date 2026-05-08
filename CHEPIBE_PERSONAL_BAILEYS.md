# CHEPIBE_PERSONAL_BAILEYS.md — Plan for `chepibe-personal`

## Context

`chepibe-personal` is the **primary WhatsApp worker** for personal bots. It is imported as `@chepibe-personal/whatsapp-worker` from `chepibe-personal-landing`.

**Current architecture**: Single-process. No Redis PubSub. No `core-api` split. The `BaileysConnectionManager` is an 897-line god class inside the worker package.

**Key files**:
- `packages/whatsapp-worker/src/infrastructure/whatsapp/baileys-connection.manager.ts` (897 lines)
- `packages/whatsapp-worker/src/infrastructure/whatsapp/signal-key-store.ts` (262 lines)
- `packages/whatsapp-worker/src/chepibe-bot/chepibe-bot.ts` (203 lines, orchestrator)

**Current consumers**:
- `packages/web/src/lib/server/bot.ts` (web app bot singleton)
- `packages/bot-manager/src/bot-pool.ts` (via npm dependency)

---

## Phase 1: Stabilize (1-2 weeks)

### 1.1 Add `async-mutex` to `BaileysConnectionManager`

**File**: `packages/whatsapp-worker/src/infrastructure/whatsapp/baileys-connection.manager.ts`

```typescript
import {Mutex} from 'async-mutex';

export class BaileysConnectionManager {
    private readonly sessionLock = new Mutex();
    private sessions = new Map<string, BaileysSession>();
    // ...

    async createConnection(sessionId: string): Promise<{qrCode: string}> {
        return this.sessionLock.runExclusive(async () => {
            const session = this.sessions.get(sessionId);
            if (session?.status !== SessionStatus.None) {
                await this.teardownSession(sessionId, false);
            }
            // ... rest of connection logic
        });
    }

    async handleConnectionUpdate(sessionId: string, update: ConnectionUpdate): Promise<void> {
        return this.sessionLock.runExclusive(async () => {
            const session = this.sessions.get(sessionId);
            if (!session) return;
            // ... handle update
        });
    }
}
```

**Scope**: ALL methods that touch `this.sessions`:
- `createConnection`
- `requestPairingCode`
- `reconnectWithSavedCreds`
- `teardownSession`
- `handleConnectionUpdate`
- `handleMessage`
- `sendWhatsAppMessage`

### 1.2 Extract `SessionStateMachine`

**New file**: `packages/whatsapp-worker/src/domain/session-state-machine.ts`

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

    transition(to: SessionStatus, context: string): void {
        if (!VALID_TRANSITIONS[this.state].includes(to)) {
            throw new Error(`Invalid transition: ${this.state} -> ${to}: ${context}`);
        }
        this.log.push({from: this.state, to, at: Date.now(), context});
        this.state = to;
    }

    getState(): SessionStatus {
        return this.state;
    }

    getLog(): readonly TransitionRecord[] {
        return this.log;
    }
}
```

**Migrate** `BaileysSession.status` from `string` to `SessionStateMachine`.

### 1.3 Replace `hasResolved` with `AbortController`

**Location**: `createConnection()` and `requestPairingCode()` methods.

**Before**:
```typescript
return new Promise((resolve, reject) => {
    let hasResolved = false;
    const timeout = setTimeout(() => {
        if (!hasResolved) { hasResolved = true; reject(...); }
    }, 120_000);
    // ...
});
```

**After**:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120_000);

try {
    for await (const event of connectionEvents(socket, controller.signal)) {
        if (event.qr) await onQR(event.qr);
        if (event.connection === 'open') return onOpen(event);
        if (event.connection === 'close') return onClose(event);
    }
} finally {
    clearTimeout(timeout);
}
```

### 1.4 Switch `ev.on()` to `ev.process()`

**Before**:
```typescript
socket.ev.on('messages.upsert', handler1);
socket.ev.on('connection.update', handler2);
socket.ev.on('creds.update', handler3);
```

**After**:
```typescript
await socket.ev.process(async (events) => {
    if (events['messages.upsert']) await handleMessages(events['messages.upsert']);
    if (events['connection.update']) await handleConnectionUpdate(events['connection.update']);
    if (events['creds.update']) await keyStore.saveCreds();
});
```

### 1.5 Fix `SqliteKeyStore` flush races

**File**: `packages/whatsapp-worker/src/infrastructure/whatsapp/signal-key-store.ts`

Replace the `isFlushing` flag pattern with a queue approach:

```typescript
class SqliteKeyStore {
    private queue: KeyMutation[] = [];
    private flushPromise: Promise<void> | null = null;

    async set(type: string, id: string, data: string): Promise<void> {
        this.queue.push({type, id, data});
        await this.maybeFlush();
    }

    private async maybeFlush(): Promise<void> {
        if (this.queue.length >= FLUSH_THRESHOLD || !this.flushPromise) {
            const flush = this.doFlush();
            this.flushPromise = flush;
            await flush;
            this.flushPromise = null;
        }
    }

    private async doFlush(): Promise<void> {
        const batch = this.queue.splice(0);
        try {
            await this.db.transaction().execute(async (trx) => {
                for (const mutation of batch) {
                    await trx.insertInto('whatsapp_session_keys')
                        .values(mutation)
                        .onConflict(oc => oc.column('id').doUpdateSet(mutation))
                        .execute();
                }
            });
        } catch (err) {
            this.queue.unshift(...batch);
            throw err;
        }
    }
}
```

### 1.6 Stop swallowing errors in `AudioHandler` and `GroqClient`

**File**: `packages/whatsapp-worker/src/infrastructure/groq/audio-handler.ts`

**Before**:
```typescript
try {
    await this.groqClient.processAudioMessage(...);
} catch (err) {
    this.logger.error(...);
}
```

**After**:
```typescript
try {
    await this.groqClient.processAudioMessage(...);
} catch (err) {
    this.logger.error(...);
    throw new AudioProcessingError('Failed to process audio', {cause: err});
}
```

### Phase 1 Deliverables

- [ ] All session operations guarded by `Mutex`
- [ ] Zero `hasResolved` flags
- [ ] One `ev.process()` per socket
- [ ] `SessionStateMachine` test suite (100% transition coverage)
- [ ] Zero silent error swallowing in audio/groq pipeline
- [ ] `SqliteKeyStore` flush race fixed

---

## Phase 2: Extract Session Actor (2-3 weeks)

### 2.1 Goal

Replace the 897-line `BaileysConnectionManager` with isolated `SessionActor` instances.

### 2.2 Move from global Maps to per-session ownership

**Before**:
```typescript
class BaileysConnectionManager {
    private sessions = new Map<string, BaileysSession>();
    private reconnectAttempts = new Map<string, number>();
    // ... 6 more maps
}
```

**After**:
```typescript
class SessionActor {
    readonly sessionId: string;
    readonly phoneNumber: string;
    
    private state: SessionStateMachine;
    private reconnectAttempts = 0;
    private socket: WASocket | null = null;
    private keyStore: SqliteKeyStore;
    private lock: Mutex;
    private scope: SessionScope;
    
    // All session state lives here. Nothing shared.
}

class SocketManager {
    private actors = new Map<string, SessionActor>();
    // Only routing. No state mutation.
}
```

### 2.3 `SessionActor` testability with `MockWASocket`

Create `packages/whatsapp-worker/src/tests/mock-wa-socket.ts`:

```typescript
export class MockWASocket implements Pick<WASocket, 'ev' | 'end'> {
    ev = new EventEmitter() as WASocket['ev'];
    
    simulateOpen(): void {
        this.ev.emit('connection.update', {connection: 'open'});
    }
    
    simulateClose(code: number): void {
        this.ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: {statusCode: code, error: new Error('test')},
        });
    }
    
    simulateMessage(msg: WAMessage): void {
        this.ev.emit('messages.upsert', {messages: [msg], type: 'notify'});
    }
    
    async end(): Promise<void> {
        this.ev.removeAllListeners();
    }
}
```

Write integration tests for the full `SessionActor` lifecycle.

### 2.4 Move `chepibe-bot.ts` to use `SessionActor`

`ChepibeBot` becomes a thin wrapper:

```typescript
class ChepibeBot extends EventEmitter {
    private actor: SessionActor;
    
    async start(): Promise<void> {
        const result = await this.actor.start();
        if (!result.ok) throw result.error;
        this.emit('CONNECTED', {phoneNumber: this.actor.phoneNumber});
    }
    
    async destroy(): Promise<void> {
        await this.actor.stop();
        this.emit('DISCONNECTED', {reason: 'shutdown'});
    }
}
```

### Phase 2 Deliverables

- [ ] `BaileysConnectionManager` deleted (replaced by `SocketManager` + `SessionActor`)
- [ ] Each `SessionActor` fully isolated, own socket, own state
- [ ] `MockWASocket` enables unit testing without real WhatsApp
- [ ] `ChepibeBot` is a thin event-emitting wrapper

---

## Phase 3: Observability (1 week)

### 3.1 Structured logging for every transition

```typescript
this.stateMachine.onTransition((from, to, context) => {
    this.logger.info({
        sessionId: this.sessionId,
        from,
        to,
        context,
        durationMs: Date.now() - this.startedAt,
    }, 'Transition');
});
```

### 3.2 Add `healthcheck` endpoint

```typescript
app.get('/health', (req, res) => {
    const healthy = [...this.actors.values()].every(a => a.isResponsive());
    res.status(healthy ? 200 : 503).json({ok: healthy});
});
```

### 3.3 Graceful shutdown

```typescript
process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    for (const [id, actor] of socketManager.actors) {
        logger.info({sessionId: id}, 'Stopping actor');
        await actor.stop();
    }
    await db.destroy();
    process.exit(0);
});
```

---

## Total Effort

| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 1: Stabilize | 1-2 weeks | Mutex, state machine, ev.process(), error propagation |
| Phase 2: Session Actor | 2-3 weeks | Extract actor, delete god object, add tests |
| Phase 3: Observability | 1 week | Logging, metrics, health, graceful shutdown |
| **Total** | **4-6 weeks** | Single engineer for Phases 1 + 3; 2 engineers for Phase 2 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `Mutex` causes deadlocks if nested incorrectly | Only acquire lock at entry points; never call `runExclusive` inside `runExclusive` |
| `ev.process()` breaks under load (slow handler blocks all events) | Keep handlers fast; move heavy work (Groq, DB writes) to background queue within same lock |
| `SessionActor` memory leak after many reconnects | `stop()` must call `socket.end()`, clear all handlers, delete from `actors` map |
| `MockWASocket` doesn't match real baileys behavior | Add integration tests against staging account with real WhatsApp |
