# Ciclo de Vida de la Sesión de WhatsApp

## Máquina de Estados

Una sesión transita por un conjunto finito de estados. Cada transición cuenta con un único punto de entrada (`doTeardown`) para la limpieza, lo que elimina errores de doble eliminación y fugas del almacén de claves.

```mermaid
stateDiagram-v2
    direction TB

    [*] --> none : startQR() / startPairing()
    none --> pending : WebSocket abierto, esperando QR o pairing code
    pending --> pending : QR generado (resuelve promesa)
    pending --> pending : Pairing code generado (resuelve promesa)
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
    destroyed --> none : startQR() / startPairing() con el mismo ID
```

### Descripción de los Estados

| Estado | ¿En memoria? | ¿Datos en DB? | Significado |
|--------|-------------|---------------|-------------|
| `none` | No | Quizás | No hay sesión activa para este ID |
| `pending` | Sí | Sí (creds nuevos) | WebSocket abierto, esperando escaneo de QR o ingreso de pairing code |
| `connected` | Sí | Sí (creds + estado) | Autenticado, procesando mensajes |
| `reconnecting` | Sí | Sí | Entre cierre y apertura, reintento con retardo exponencial |
| `destroyed` | No | No (eliminados) | Sesión destruida, no puede restaurarse |

### Observación Clave

Existen únicamente dos formas en que una sesión abandona la máquina:

1. **`doTeardown(deleteData: true)`** — Elimina los datos de la base de datos. Utilizado para: cierre de sesión 401, número de teléfono no coincidente, solicitud de desconexión, timeout de QR, timeout de pairing code, cierre de conexión antes del QR. La sesión no puede restaurarse.
2. **`doTeardown(deleteData: false)`** — Preserva los datos de la base de datos. Utilizado para: apagado ordenado. La sesión puede restaurarse al reiniciar.

## Tabla de Decisiones de Desconexión

Cada sitio de invocación que finaliza una sesión pasa por `doTeardown`. A continuación se detalla cuándo se utiliza cada modo:

```mermaid
flowchart TD
    A[La sesión necesita finalización] --> B{¿Deben sobrevivir los datos al reinicio?}
    B -->|No| C[doTeardown deleteData: true]
    B -->|Sí| D[doTeardown deleteData: false]

    C --> C1[401: sesión cerrada]
    C --> C2[Número de teléfono no coincide]
    C --> C3[Solicitud de desconexión]
    C --> C4[Timeout de QR - aún no hay sesión válida]
    C --> C5[Timeout de pairing code - aún no hay sesión válida]
    C --> C6[Cierre de conexión antes del QR]

    D --> D1[Apagado ordenado - preservar para restaurar]
```

| Disparador | `deleteData` | Motivo |
|---------|-------------|--------|
| Solicitud de desconexión | `true` | El usuario solicitó la desconexión explícitamente |
| Cierre de sesión 401 | `true` | El teléfono cerró sesión explícitamente, las credenciales son inválidas |
| Número de teléfono no coincide | `true` | Teléfono incorrecto, no debe restaurarse |
| Timeout de QR (60s) | `true` | Aún no se estableció una sesión válida |
| Timeout de pairing code (60s) | `true` | Aún no se estableció una sesión válida |
| Cierre de conexión antes del QR | `true` | Aún no se estableció una sesión válida |
| Apagado ordenado (`destroy()`) | `false` | Debe sobrevivir al reinicio del contenedor |
| `startQR`/`startPairing` reemplazando existente | `true` | Reemplazar la sesión limpia, datos frescos |
| Programación de reconexión (evento close) | Ninguno | Sin teardown — solo programa la reconexión |

## Diagramas de Secuencia

### Conexión Nueva (Escaneo de QR)

```mermaid
sequenceDiagram
    participant BOT as ChepibeBot.getQR()
    participant DB as SQLite
    participant WS as WhatsAppSession
    participant BA as Baileys (WhatsApp)

    BOT->>WS: startQR()
    WS->>WS: Mutex lock
    WS->>DB: loadOrCreateAuthState() — cargar o iniciar creds
    WS->>DB: SignalKeyStore.loadFromDB()
    WS->>BA: makeWASocket(creds, keys)
    BA-->>WS: connection.update { qr }
    WS-->>BOT: { qrCode }
    Note over BOT: El usuario escanea el QR
    BA-->>WS: connection.update { connection: "open" }
    WS->>DB: saveCredentials()
    WS->>DB: updateSessionStatus("connected")
    WS-->>WS: emitir CONNECTED
```

### Conexión Nueva con Código de Emparejamiento (Pairing Code)

Alternativa al QR: el usuario solicita un código de 8 dígitos ingresando su número de teléfono, y lo ingresa manualmente en WhatsApp.

```mermaid
sequenceDiagram
    participant W as Web UI (/qr)
    participant SVR as +page.server.ts
    participant BOT as ChepibeBot.requestPairingCode()
    participant WS as WhatsAppSession
    participant DB as SQLite
    participant BA as Baileys (WhatsApp)

    W->>SVR: POST form (action default)
    SVR->>SVR: Lee ALLOWED_PHONE de env
    SVR->>BOT: requestPairingCode(phoneNumber)
    BOT->>WS: startPairing(phoneNumber)
    WS->>WS: Mutex lock
    WS->>DB: loadOrCreateAuthState() — cargar o iniciar creds
    WS->>DB: SignalKeyStore.loadFromDB()
    WS->>BA: makeWASocket(creds, keys)
    BA-->>WS: connection.update { qr }
    WS->>BA: socket.requestPairingCode(phoneNumber)
    BA-->>WS: código de 8 dígitos
    WS-->>BOT: { code }
    BOT-->>SVR: { code }
    SVR-->>W: Muestra código de 8 dígitos
    Note over W: El usuario ingresa el código en
    WhatsApp → Dispositivos Vinculados →
    Vincular un dispositivo
    BA-->>WS: connection.update { connection: "open" }
    WS->>DB: saveCredentials()
    WS->>DB: updateSessionStatus("connected")
    WS-->>WS: emitir CONNECTED
```

**Duración del timeout:** 60 segundos. Si el código no se ingresa en ese tiempo, la sesión se destruye (`doTeardown(deleteData: true, reason: 'pairing_timeout')`).

**Número de teléfono:** Se toma de la variable de entorno `ALLOWED_PHONE` (formato internacional sin el signo `+`, ej. `5491171234567`).

### Reconexión Tras Reinicio

```mermaid
sequenceDiagram
    participant BOT as ChepibeBot.start()
    participant DB as SQLite
    participant WS as WhatsAppSession
    participant BA as Baileys (WhatsApp)

    BOT->>DB: SELECT * FROM whatsapp_sessions LIMIT 1
    BOT->>WS: new WhatsAppSession(sessionId, db, ...)
    WS->>DB: loadOrCreateAuthState() — cargar creds guardadas
    WS->>DB: SignalKeyStore.loadFromDB()
    WS->>BA: makeWASocket(savedCreds, savedKeys)
    BA-->>WS: connection.update { connection: "open" }
    WS->>DB: saveCredentials()
    WS->>DB: updateSessionStatus("connected")
```

### Cierre de Conexión + Reconexión

```mermaid
sequenceDiagram
    participant BA as Baileys (WhatsApp)
    participant WS as WhatsAppSession
    participant DB as SQLite

    BA-->>WS: connection.update { connection: "close", statusCode: 428 }
    WS->>WS: reconnectAttempts++
    WS->>WS: Programar reconexión (retardo 2^intentos, máx. 60s)
    Note over WS: Tras el retardo...
    WS->>DB: loadOrCreateAuthState() — cargar creds guardadas
    WS->>DB: SignalKeyStore.loadFromDB()
    WS->>BA: makeWASocket(savedCreds)
    BA-->>WS: connection.update { connection: "open" }
    WS->>DB: saveCredentials()
    WS->>DB: updateSessionStatus("connected")
```

### Cierre de Sesión 401 (Permanente)

```mermaid
sequenceDiagram
    participant BA as Baileys (WhatsApp)
    participant WS as WhatsAppSession
    participant DB as SQLite

    BA-->>WS: connection.update { connection: "close", statusCode: 401 }
    WS->>WS: doTeardown(deleteData: true, reason: "logged_out")
    WS->>WS: cancelar temporizadores de reconexión
    WS->>WS: vaciar escrituras de claves pendientes
    WS->>WS: cerrar WebSocket
    WS->>DB: DELETE FROM whatsapp_session_keys WHERE sessionId = ?
    WS->>DB: DELETE FROM whatsapp_sessions WHERE id = ?
    WS-->>WS: emitir DISCONNECTED { reason: "logged_out" }
```

### Solicitud de Desconexión

```mermaid
sequenceDiagram
    participant BOT as ChepibeBot.disconnect()
    participant WS as WhatsAppSession
    participant DB as SQLite

    BOT->>WS: destroy()
    WS->>WS: doTeardown(deleteData: true)
    WS->>WS: cancelar temporizadores de reconexión
    WS->>WS: vaciar escrituras de claves pendientes
    WS->>WS: cerrar WebSocket
    WS->>DB: DELETE FROM whatsapp_session_keys WHERE sessionId = ?
    WS->>DB: DELETE FROM whatsapp_sessions WHERE id = ?
    WS-->>BOT: vacío
```

### Apagado Ordenado

```mermaid
sequenceDiagram
    participant SIG as SIGTERM/SIGINT
    participant BOT as ChepibeBot.destroy()
    participant WS as WhatsAppSession
    participant DB as SQLite

    SIG->>BOT: señal de apagado
    BOT->>WS: destroy()
    WS->>WS: doTeardown(deleteData: false)
    WS->>WS: cancelar temporizadores de reconexión
    WS->>WS: vaciar escrituras de claves pendientes
    WS->>WS: cerrar WebSocket
    WS->>DB: UPDATE sessions SET status = "destroyed"
    Note over DB: Datos preservados para restaurar en el próximo inicio
```
