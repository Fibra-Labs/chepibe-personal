# Ciclo de Vida de la Sesión de WhatsApp

## Máquina de Estados

Una sesión transita por un conjunto finito de estados. Cada transición cuenta con un único punto de entrada (`teardownSession`) para la limpieza, lo que elimina errores de doble eliminación y fugas del almacén de claves.

```mermaid
stateDiagram-v2
    direction TB

    [*] --> none : createConnection()
    none --> pending : WebSocket abierto, esperando QR
    pending --> pending : QR generado (resuelve promesa)
    pending --> connected : connection.update = "open"
    pending --> destroyed : connection.update = "close" (timeout/401/otro)
    pending --> reconnecting : connection.update = "close" (515)

    connected --> connected : messages.upsert, creds.update
    connected --> reconnecting : connection.update = "close" (no 401)
    connected --> destroyed : número de teléfono no coincide / solicitud de desconexión

    reconnecting --> connected : connection.update = "open"
    reconnecting --> reconnecting : reintento con retardo exponencial (máx. 10)
    reconnecting --> destroyed : máx. reintentos excedido / 401

    destroyed --> [*] : datos eliminados (no se pueden restaurar)
    destroyed --> none : createConnection() con el mismo ID
```

### Descripción de los Estados

| Estado | ¿En memoria? | ¿Datos en DB? | Significado |
|--------|-------------|---------------|-------------|
| `none` | No | Quizás | No hay sesión activa para este ID |
| `pending` | Sí | Sí (creds nuevos) | WebSocket abierto, esperando escaneo de QR |
| `connected` | Sí | Sí (creds + estado) | Autenticado, procesando mensajes |
| `reconnecting` | Sí | Sí | Entre cierre y apertura, reintento con retardo exponencial |
| `destroyed` | No | No (eliminados) | Sesión destruida, no puede restaurarse |

### Observación Clave

Existen únicamente dos formas en que una sesión abandona la máquina:

1. **`teardownSession(id, { deleteData: true })`** — Elimina los datos de la base de datos. Utilizado para: cierre de sesión 401, número de teléfono no coincidente, solicitud de desconexión, timeout de QR, cierre de conexión antes del QR. La sesión no puede restaurarse.
2. **`teardownSession(id, { deleteData: false })`** — Preserva los datos de la base de datos. Utilizado para: apagado ordenado, preparación de reconexión. La sesión puede restaurarse al reiniciar.

## Tabla de Decisiones de Desconexión

Cada sitio de invocación que finaliza una sesión pasa por `teardownSession`. A continuación se detalla cuándo se utiliza cada modo:

```mermaid
flowchart TD
    A[La sesión necesita finalización] --> B{¿Deben sobrevivir los datos al reinicio?}
    B -->|No| C[teardown deleteData: true]
    B -->|Sí| D[teardown deleteData: false]

    C --> C1[401: sesión cerrada]
    C --> C2[Número de teléfono no coincide]
    C --> C3[Solicitud de desconexión]
    C --> C4[Timeout de QR - aún no hay sesión válida]
    C --> C5[Cierre de conexión antes del QR]

    D --> D1[Apagado ordenado - preservar para restaurar]
    D --> D2[createConnection reemplazando sesión existente]
```

| Disparador | `deleteData` | Motivo |
|---------|-------------|--------|
| Solicitud de desconexión | `true` | El usuario solicitó la desconexión explícitamente |
| Cierre de sesión 401 | `true` | El teléfono cerró sesión explícitamente, las credenciales son inválidas |
| Número de teléfono no coincide | `true` | Teléfono incorrecto, no debe restaurarse |
| Timeout de QR (60s) | `true` | Aún no se estableció una sesión válida |
| Cierre de conexión antes del QR | `true` | Aún no se estableció una sesión válida |
| Apagado ordenado (`destroy()`) | `false` | Debe sobrevivir al reinicio del contenedor |
| `createConnection` reemplazando existente | `false` | Las credenciales pueden seguir siendo válidas para reconectar |
| Programación de reconexión (evento close) | Ninguno | Sin teardown — solo programa la reconexión |

## Diagramas de Secuencia

### Conexión Nueva (Escaneo de QR)

```mermaid
sequenceDiagram
    participant BOT as ChepibeBot.getQR()
    participant MGR as BaileysConnectionManager
    participant DB as SQLite
    participant BA as Baileys (WhatsApp)
    participant WS as WebSocket

    BOT->>MGR: createConnection(sessionId)
    MGR->>MGR: teardownSession(id, deleteData: false) si existe
    MGR->>DB: loadOrCreateAuthState() — cargar o iniciar creds
    MGR->>DB: SqliteKeyStore.loadFromDB()
    MGR->>BA: makeWASocket(creds, keys)
    BA->>WS: conectar a servidores de WhatsApp
    WS-->>BA: código QR
    BA-->>MGR: connection.update { qr }
    MGR-->>BOT: { qrCode }
    Note over BOT: El usuario escanea el QR
    WS-->>BA: connection.open
    BA-->>MGR: connection.update { connection: "open" }
    MGR->>DB: saveCredentials()
    MGR->>DB: updateSessionStatus("connected")
    MGR-->>MGR: emitir CONNECTED
```

### Reconexión Tras Reinicio

```mermaid
sequenceDiagram
    participant BOT as ChepibeBot.start()
    participant MGR as BaileysConnectionManager
    participant DB as SQLite
    participant BA as Baileys (WhatsApp)

    BOT->>MGR: restoreSessions()
    MGR->>DB: SELECT * FROM whatsapp_sessions
    loop Para cada sesión con creds
        MGR->>DB: loadOrCreateAuthState() — cargar creds guardadas
        MGR->>DB: SqliteKeyStore.loadFromDB()
        MGR->>BA: makeWASocket(savedCreds, savedKeys)
        BA-->>MGR: connection.update { connection: "open" }
        MGR->>DB: saveCredentials()
        MGR->>DB: updateSessionStatus("connected")
    end
```

### Cierre de Conexión + Reconexión

```mermaid
sequenceDiagram
    participant BA as Baileys (WhatsApp)
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    BA-->>MGR: connection.update { connection: "close", statusCode: 428 }
    MGR->>MGR: reconnectAttempts++
    MGR->>MGR: Programar reconexión (retardo 2^intentos, máx. 60s)
    Note over MGR: Tras el retardo...
    MGR->>DB: loadOrCreateAuthState() — cargar creds guardadas
    MGR->>DB: SqliteKeyStore.loadFromDB()
    MGR->>BA: makeWASocket(savedCreds)
    BA-->>MGR: connection.update { connection: "open" }
    MGR->>DB: saveCredentials()
    MGR->>DB: updateSessionStatus("connected")
```

### Cierre de Sesión 401 (Permanente)

```mermaid
sequenceDiagram
    participant BA as Baileys (WhatsApp)
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    BA-->>MGR: connection.update { connection: "close", statusCode: 401 }
    MGR->>MGR: teardownSession(id, { deleteData: true, reason: "logged_out" })
    MGR->>MGR: cancelar temporizadores de reconexión
    MGR->>MGR: vaciar escrituras de claves pendientes
    MGR->>MGR: cerrar WebSocket
    MGR->>DB: DELETE FROM whatsapp_session_keys WHERE sessionId = ?
    MGR->>DB: DELETE FROM whatsapp_sessions WHERE id = ?
    MGR->>MGR: eliminar del mapa de sesiones
    MGR-->>MGR: emitir DISCONNECTED { reason: "logged_out" }
```

### Solicitud de Desconexión

```mermaid
sequenceDiagram
    participant BOT as ChepibeBot.disconnect()
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    BOT->>MGR: disconnectSession(sessionId)
    MGR->>MGR: teardownSession(id, { deleteData: true })
    MGR->>MGR: cancelar temporizadores de reconexión
    MGR->>MGR: vaciar escrituras de claves pendientes
    MGR->>MGR: cerrar WebSocket
    MGR->>DB: DELETE FROM whatsapp_session_keys WHERE sessionId = ?
    MGR->>DB: DELETE FROM whatsapp_sessions WHERE id = ?
    MGR->>MGR: eliminar del mapa de sesiones
    MGR-->>BOT: vacío
```

### Apagado Ordenado

```mermaid
sequenceDiagram
    participant SIG as SIGTERM/SIGINT
    participant BOT as ChepibeBot.destroy()
    participant MGR as BaileysConnectionManager
    participant DB as SQLite

    SIG->>BOT: señal de apagado
    BOT->>MGR: destroy()
    loop Para cada sesión activa
        MGR->>MGR: teardownSession(id, { deleteData: false })
        MGR->>MGR: cancelar temporizadores de reconexión
        MGR->>MGR: vaciar escrituras de claves pendientes
        MGR->>MGR: cerrar WebSocket
        MGR->>DB: UPDATE sessions SET status = "disconnected"
        Note over DB: Datos preservados para restaurar en el próximo inicio
    end
```

## Canalización de Flush del Almacén de Claves

Las claves del protocolo Signal no se escriben en la base de datos inmediatamente: se agrupan en lotes y se persisten cada 2 segundos.

```mermaid
flowchart TB
    A["Baileys creds.update"] --> B["SqliteKeyStore.set()"]
    B --> C["cache.set(key, value)"]
    B --> D["mutationQueue.push({type, id, value, operation})"]

    E["⏱️ Cada 2s o cola > 1000"] --> F["flushMutations()"]
    F --> G["batch = mutationQueue.splice(0)"]
    G --> H["UPSERT / DELETE en SQLite"]
    H --> I{"¿Error?"}
    I -->|SQLITE_READONLY_DBMOVED| J["Reintentar hasta 3 veces"]
    J -->|Falló 3 veces| K["🗑️ Descartar cola"]
    I -->|Otro error| L["Re-encolar lote<br/>reintentar próximo intervalo"]
    I -->|OK| M["✅ Flush exitoso"]

    N["Finalización de sesión"] --> O["forceFlush()"]
    O --> P["destroy()<br/>(detiene intervalo de flush)"]

    style K fill:#ffcccc,stroke:#ff0000
    style M fill:#ccffcc,stroke:#00cc00
```

## Protección contra SQLITE_READONLY_DBMOVED

La aplicación establece `PRAGMA journal_mode=DELETE` al momento de la conexión para evitar que el auto-checkpoint de WAL modifique el inodo del archivo de la base de datos en montajes enlazados de Docker sobre macOS (osxfs).

Como medida de defensa en profundidad, `SqliteKeyStore.flushMutations()` detecta específicamente los errores DBMOVED:

1. En la primera ocurrencia: registra el error e intenta `PRAGMA journal_mode=DELETE` para recuperar la conexión
2. Hasta 3 reintentos: continúa intentando los flushes
3. Tras 3 fallas consecutivas: descarta la cola de mutaciones (evita el crecimiento ilimitado y el cierre por rechazo de promesa no manejado) y registra `fatal`
4. En un flush exitoso: reinicia el contador de errores consecutivos

Esto evita la espiral de fallos que anteriormente provocaba el cierre del proceso: las mutaciones se acumulaban, cada flush fallaba con DBMOVED y finalmente se producía un rechazo de promesa no manejado.
