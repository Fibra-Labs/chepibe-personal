# WhatsApp Session Lifecycle

## State Machine

A session progresses through a finite set of states. Every transition has one entry point (`teardownSession`) for cleanup, which eliminates double-delete bugs and key store leaks.

```mermaid
stateDiagram-v2
    direction TB

    [*] --> none : API: createConnection()
    none --> pending : WebSocket opened, waiting for QR
    pending --> pending : QR generated (resolve promise)
    pending --> connected : connection.update = "open"
    pending --> destroyed : connection.update = "close" (timeout/401/other)
    pending --> reconnecting : connection.update = "close" (515)

    connected --> connected : messages.upsert, creds.update
    connected --> reconnecting : connection.update = "close" (not 401)
    connected --> destroyed : phone mismatch / API disconnect

    reconnecting --> connected : connection.update = "open"
    reconnecting --> reconnecting : backoff retry (max 10)
    reconnecting --> destroyed : max retries exceeded / 401

    destroyed --> [*] : data deleted (cannot restore)
    destroyed --> none : API: createConnection() with same ID
```

### State Descriptions

| State | In-memory? | Data in DB? | Meaning |
|-------|-----------|-------------|---------|
| `none` | No | Maybe | No active session for this ID |
| `pending` | Yes | Yes (new creds) | WebSocket open, waiting for QR scan |
| `connected` | Yes | Yes (creds + status) | Authenticated, processing messages |
| `reconnecting` | Yes | Yes | Between close and open, backoff retry |
| `destroyed` | No | No (deleted) | Session nuked, cannot be restored |

### Key Insight

There are only two ways a session exits the machine:

1. **`teardownSession(id, { deleteData: true })`** — Nukes DB data. Used for: 401 logout, phone mismatch, API disconnect, QR timeout, connection closed before QR. The session cannot be restored.
2. **`teardownSession(id, { deleteData: false })`** — Preserves DB data. Used for: graceful shutdown, reconnection prep. The session can be restored on restart.

## Disconnection Decision Table

Every call site that tears down a session goes through `teardownSession`. Here's when each mode is used:

```mermaid
flowchart TD
    A[Session needs teardown] --> B{Should data survive restart?}
    B -->|No| C[teardown deleteData: true]
    B -->|Yes| D[teardown deleteData: false]

    C --> C1[401: logged out]
    C --> C2[Phone number mismatch]
    C --> C3[API disconnect request]
    C --> C4[QR timeout - no valid session yet]
    C --> C5[Connection close before QR]

    D --> D1[Graceful shutdown - preserve for restore]
    D --> D2[createConnection replacing existing session]
```

| Trigger | `deleteData` | Reason |
|---------|-------------|--------|
| API `/api/disconnect` | `true` | User explicitly requested disconnect |
| 401 logout | `true` | Phone explicitly logged out, creds are invalid |
| Phone mismatch | `true` | Wrong phone, must not restore |
| QR timeout (30s) | `true` | No valid session established yet |
| Connection close before QR | `true` | No valid session established yet |
| Graceful shutdown (`destroy()`) | `false` | Must survive container restart |
| `createConnection` replacing existing | `false` | Credentials may still be valid for reconnect |
| Reconnection scheduling (close event) | Neither | No teardown — just schedules reconnect |

## Sequence Diagrams

### Fresh Connection (QR Scan)

```mermaid
sequenceDiagram
    participant API as /api/qr
    participant MGR as BaileysConnectionManager
    participant DB as SQLite
    participant BA as Baileys (WhatsApp)
    participant WS as WebSocket

    API->>MGR: createConnection(sessionId)
    MGR->>MGR: teardownSession(id, deleteData: false) if existing
    MGR->>DB: loadOrCreateAuthState() — load or init creds
    MGR->>DB: SqliteKeyStore.loadFromDB()
    MGR->>BA: makeWASocket(creds, keys)
    BA->>WS: connect to WhatsApp servers
    WS-->>BA: QR code
    BA-->>MGR: connection.update { qr }
    MGR-->>API: { qrCode }
    Note over API: User scans QR
    WS-->>BA: connection.open
    BA-->>MGR: connection.update { connection: "open" }
    MGR->>DB: saveCredentials()
    MGR->>DB: updateSessionStatus("connected")
    MGR-->>MGR: emit CONNECTED
```

### Reconnection After Restart

```mermaid
sequenceDiagram
    participant MAIN as main.ts
    participant MGR as BaileysConnectionManager
    participant DB as SQLite
    participant BA as Baileys (WhatsApp)

    MAIN->>MGR: restoreSessions()
    MGR->>DB: SELECT * FROM whatsapp_sessions
    loop For each session with creds
        MGR->>DB: loadOrCreateAuthState() — load saved creds
        MGR->>DB: SqliteKeyStore.loadFromDB()
        MGR->>BA: makeWASocket(savedCreds, savedKeys)
        BA-->>MGR: connection.update { connection: "open" }
        MGR->>DB: saveCredentials()
        MGR->>DB: updateSessionStatus("connected")
    end
```

### Connection Close + Reconnection

```mermaid
sequenceDiagram
    participant BA as Baileys (WhatsApp)
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    BA-->>MGR: connection.update { connection: "close", statusCode: 428 }
    MGR->>MGR: reconnectAttempts++
    MGR->>MGR: Schedule reconnect (2^attempts delay, max 60s)
    Note over MGR: After delay...
    MGR->>DB: loadOrCreateAuthState() — load saved creds
    MGR->>DB: SqliteKeyStore.loadFromDB()
    MGR->>BA: makeWASocket(savedCreds)
    BA-->>MGR: connection.update { connection: "open" }
    MGR->>DB: saveCredentials()
    MGR->>DB: updateSessionStatus("connected")
```

### 401 Logout (Permanent)

```mermaid
sequenceDiagram
    participant BA as Baileys (WhatsApp)
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    BA-->>MGR: connection.update { connection: "close", statusCode: 401 }
    MGR->>MGR: teardownSession(id, { deleteData: true, reason: "logged_out" })
    MGR->>MGR: cancel reconnect timers
    MGR->>MGR: flush pending key writes
    MGR->>MGR: close WebSocket
    MGR->>DB: DELETE FROM whatsapp_session_keys WHERE sessionId = ?
    MGR->>DB: DELETE FROM whatsapp_sessions WHERE id = ?
    MGR->>MGR: remove from sessions map
    MGR-->>MGR: emit DISCONNECTED { reason: "logged_out" }
```

### API Disconnect

```mermaid
sequenceDiagram
    participant API as /api/disconnect
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    API->>MGR: disconnectSession(sessionId)
    MGR->>MGR: teardownSession(id, { deleteData: true })
    MGR->>MGR: cancel reconnect timers
    MGR->>MGR: flush pending key writes
    MGR->>MGR: close WebSocket
    MGR->>DB: DELETE FROM whatsapp_session_keys WHERE sessionId = ?
    MGR->>DB: DELETE FROM whatsapp_sessions WHERE id = ?
    MGR->>MGR: remove from sessions map
    MGR-->>API: { ok: true }
```

### Graceful Shutdown

```mermaid
sequenceDiagram
    participant SIG as SIGTERM/SIGINT
    participant MAIN as main.ts
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    SIG->>MAIN: shutdown signal
    MAIN->>MGR: destroy()
    loop For each active session
        MGR->>MGR: teardownSession(id, { deleteData: false })
        MGR->>MGR: cancel reconnect timers
        MGR->>MGR: flush pending key writes
        MGR->>MGR: close WebSocket
        MGR->>DB: UPDATE sessions SET status = "disconnected"
        Note over DB: Data preserved for restore on next start
    end
```

## Key Store Flush Pipeline

Signal protocol keys are not written to DB immediately — they're batched and flushed every 2 seconds.

```
Baileys creds.update
    → SqliteKeyStore.set()
        → cache.set(key, value)
        → mutationQueue.push({ type, id, value, operation })

Every 2 seconds (or when queue > 1000):
    → flushMutations()
        → batch = mutationQueue.splice(0)
        → for each upsert: INSERT ... ON CONFLICT DO UPDATE
        → for each delete: DELETE WHERE ...
        → on error:
            → SQLITE_READONLY_DBMOVED: retry up to 3x, then discard queue
            → other errors: re-queue batch, retry next interval

On session teardown:
    → SqliteKeyStore.forceFlush()
    → SqliteKeyStore.destroy() — stops flush interval
```

## SQLITE_READONLY_DBMOVED Protection

The app sets `PRAGMA journal_mode=DELETE` at connection time to prevent WAL auto-checkpoint from changing the database file inode on macOS Docker bind mounts (osxfs).

As defense-in-depth, `SqliteKeyStore.flushMutations()` detects DBMOVED errors specifically:

1. On first occurrence: log error, attempt `PRAGMA journal_mode=DELETE` to recover the connection
2. Up to 3 retries: continue attempting flushes
3. After 3 consecutive failures: discard the mutation queue (prevents unbounded growth and unhandled rejection crash), log `fatal`
4. On successful flush: reset the consecutive error counter

This prevents the death spiral that crashed the process before: mutations piling up, each flush failing with DBMOVED, eventually causing an unhandled promise rejection.
