# Arquitectura

## Diagrama de Componentes

```mermaid
graph TB
    subgraph Usuario["👤 USUARIO (WhatsApp App)"]
    end

    subgraph Worker["⚙️ WhatsApp Worker"]
        A["Baileys<br/>(WebSocket)"] --> B["Descargar Audio"]
        B --> C["Groq Whisper<br/>(Transcripción)"]
        C --> D["Groq Llama<br/>(Resumen)"]
        D --> E["Baileys<br/>(Enviar al USUARIO)"]
    end

    subgraph Web["🌐 Web App (SvelteKit 5)"]
        F["Inicio (/)"]
        G["QR Code (/qr)"]
        H["Estado (/status)"]
    end

    subgraph DB["💾 Base de Datos (SQLite/Turso)"]
        I["whatsapp_sessions<br/><br/>• id, phone_number<br/>• status, creds<br/>• qr_code, timestamps"]
        J["whatsapp_session_keys<br/><br/>• session_id, key_type<br/>• key_id, key_data<br/>• timestamps"]
    end

    Usuario -->|"Nota de Voz"| A
    E -->|"Respuesta al chat"| Usuario
    A <-->|"HTTP API"| Web
    I <-->|"Persistencia"| A
    J <-->|"Signal Keys"| A
```

> **Nota de Privacidad**: Los diagramas muestran solo metadata de sesión (creds, keys). **Ningún contenido de mensaje, transcripción o audio se almacena en la DB ni en logs.**

## Flujo de Datos

> **⚠️ PRIVACIDAD ABSOLUTA**: En ningún punto del flujo se almacena o loguea contenido de mensajes, transcripciones, resúmenes o audio. Todo procesamiento es en memoria.

### 1. Recepción de Audio

```mermaid
sequenceDiagram
    participant W as WhatsApp
    participant B as Baileys
    participant M as Memoria (Buffer)

    W-->>B: WebSocket (mensaje entrante)
    B->>B: messages.upsert event
    Note over B: Filtro: solo notify/requestId
    B->>M: downloadMediaMessage() → Buffer
    Note over M: En memoria, NUNCA en disco
```

**Filtros aplicados:**
- Solo `notify` (mensajes nuevos) o `requestId` (offline)
- Solo `audioMessage` o `pttMessage`
- Mensajes propios (`fromMe`) con audio también se procesan
- **Deduplicación**: Cache 24h con key `${phoneNumber}:${msgId}`
- **LID handling**: Si el remitente es `@lid`, se usa el `phoneNumber` de la sesión

> **Nota**: Los filtros solo usan IDs de mensaje para deduplicación. **Ningún contenido de mensaje se almacena.**

### 2. Procesamiento

```mermaid
flowchart LR
    A["Buffer<br/>(memoria)"] --> B["Groq Whisper"]
    B --> C["Texto<br/>(variable local)"]
    C --> D["Groq Llama"]
    D --> E["Resumen<br/>(variable local)"]

    style A fill:#ffcccc
    style E fill:#ffcccc
```

| Paso | Servicio | Modelo | Latencia |
|------|----------|--------|----------|
| Descarga | In-memory Buffer | - | < 1s |
| Transcripción | Groq Whisper | `whisper-large-v3` | ~2-3s |
| Resumen | Groq Llama | `llama-3.1-8b-instant` | ~1-2s |
| Respuesta | Baileys | - | < 1s |

**Tiempo total típico**: 5-7 segundos

### 3. Respuesta al Usuario Conectado

**SIEMPRE se envía al usuario conectado, nunca al remitente del audio.**

```mermaid
flowchart TB
    A["Audio de otro chat"] --> B["📱 Mensaje de {número}<br/>Transcripción + Resumen"]
    C["Audio propio"] --> D["🎤 Transcripción<br/>📝 Resumen"]
    B --> E["Tu propio chat"]
    D --> E
```

```mermaid
flowchart LR
    subgraph En Memoria ["⚠️ NUNCA SE GUARDA"]
        A["Audio Buffer"] --> B["Transcripción"]
        B --> C["Resumen"]
        C --> D["Respuesta"]
        D --> E["Descartado"]
    end

    style A fill:#ffcccc,stroke:#ff0000
    style B fill:#ffcccc,stroke:#ff0000
    style C fill:#ffcccc,stroke:#ff0000
    style D fill:#ffcccc,stroke:#ff0000
    style E fill:#ffcccc,stroke:#ff0000
```

**Zero-Log**: Audio, transcripción y resumen existen solo como variables locales. Se envían directamente al chat del usuario y se descartan. **No se almacenan en DB ni se incluyen en logs.**

### Formato de Respuesta

**Audio propio:**
```
🎤 *Transcripción:*
[texto transcrito]

📝 *Resumen:*
[resumen generado]
```

**Audio de otro (grupo o DM):**
```
📱 Mensaje de 5491112345678:

🎤 *Transcripción:*
[texto transcrito]

📝 *Resumen:*
[resumen generado]
```

## Base de Datos

### Tabla: whatsapp_sessions

Almacena metadata de sesión y credenciales de Baileys.

```sql
CREATE TABLE whatsapp_sessions (
  id TEXT PRIMARY KEY,
  phone_number TEXT,
  status TEXT DEFAULT 'pending',
  creds TEXT,           -- JSON con BufferJSON.replacer
  qr_code TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
```

**Nota sobre `creds`**: Este campo contiene el estado de autenticación de Baileys, incluyendo:
- Signal Protocol credentials (identity keys, signed pre-keys, etc.)
- **`processedHistoryMessages`**: array de keys de mensajes sincronizados (solo IDs y metadata, **NO contenido**)
- Account settings y device info

El sistema **no controla** qué guarda Baileys en `creds` — es opaco para nosotros.

### Tabla: whatsapp_session_keys

Almacena las Signal Protocol keys por separado (una fila por key). Esto permite escalabilidad y queries eficientes.

```sql
CREATE TABLE whatsapp_session_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  key_type TEXT NOT NULL,         -- app-state-sync-key, sender-key-memory, etc.
  key_id TEXT NOT NULL,
  key_data TEXT,                  -- JSON con BufferJSON.replacer
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(session_id, key_type, key_id)
);
```

**Tipos de keys que Baileys almacena**:
- `app-state-sync-key` — Sincronización de estado de la app
- `sender-key-memory` — Claves de grupo (sender keys)
- `sender-key-state` — Estado de claves de grupo
- `lid-mapping` — Mapeo LID ↔ número de teléfono (Baileys v7)
- `device-list` — Lista de dispositivos (Baileys v7)
- `tctoken` — Tokens de confianza (Baileys v7)
- `pre-key`, `session` — Signal Protocol pre-keys y sesiones

### Datos NO Almacenados

- ❌ Contenido de audios
- ❌ Transcripciones
- ❌ Resúmenes
- ❌ Historial de conversaciones (texto de mensajes)
- ❌ **Contenido** de metadata de mensajes (el texto no se guarda)

**Lo que SÍ persiste en `processedHistoryMessages`** (dentro de `creds`, no controllable):
- Message IDs (referencias, no contenido)
- Timestamps
- JIDs (chat y participante)
- Flag `fromMe`

Esto es guardado automáticamente por Baileys y no contiene texto ni contenido de los mensajes.

## Comunicación Web↔Worker

### API REST (Worker)

El web llama al worker directamente via HTTP. No hay Redis ni pub/sub.

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/qr` | GET | Generar nuevo código QR (reusa sesión conectada si existe) |
| `/api/status` | GET | Estado de conexiones activas |
| `/api/sessions` | GET | Listar todas las sesiones |
| `/api/disconnect` | POST | Desconectar sesión |

## Session Persistence

Las sesiones sobreviven restarts del worker:

1. **Creds** se almacenan en `whatsapp_sessions.creds` (serializados con `BufferJSON.replacer`)
2. **Signal keys** se almacenan en `whatsapp_session_keys` (una fila por key, serializadas con `BufferJSON.replacer`)
3. **Al iniciar**, el worker carga sesiones de la DB, crea un `SqliteKeyStore` por sesión, llama `loadFromDB()` para cargar keys del cache, y reconecta automáticamente
4. **Heartbeat** cada 30s verifica que las sesiones estén activas y reconecta las que se cayeron

## Seguridad en la Arquitectura

### 1. Zero-Log Design

```mermaid
flowchart TB
    subgraph Proceso ["✅ LO QUE SÍ PASA"]
        A["🎤 Audio"] --> B["⚙️ Procesamiento"]
        B --> C["📤 Respuesta"]
        C --> D["🗑️ Descartado"]
    end

    subgraph Protegido ["❌ NUNCA SE ALMACENA"]
        E["Contenido de audio"]
        F["Transcripciones"]
        G["Resúmenes"]
        H["Texto de mensajes"]
    end

    E -.-> D
    F -.-> D
    G -.-> D
    H -.-> D
```

### 2. Credenciales

- **Groq API Key**: Variable de entorno, nunca expuesta
- **Baileys Creds**: Almacenadas en SQLite (serializadas con BufferJSON)
- **Signal Keys**: Tabla separada, serializadas con BufferJSON

### 3. Red

Baileys usa WebSocket saliente, no requiere puertos abiertos al público.



## Recursos del Sistema

### Requisitos Mínimos

| Componente | CPU | Memoria | Disco |
|------------|-----|---------|-------|
| Web | 0.1 core | 128 MB | 50 MB |
| Worker | 0.2 core | 256 MB | 50 MB |
| **Total** | **0.3 cores** | **384 MB** | **100 MB** |

## Monitoreo

### Logs

Todos los logs usan Pino (structured logging). Con `DEBUG=true` se ven logs detallados de Baileys.

**Los logs NUNCA incluyen:**
- ❌ Contenido de mensajes
- ❌ Texto de transcripciones
- ❌ Resúmenes
- ❌ Contenido de audio

**Lo que SÍ incluyen:**
- ✅ IDs de sesión, números de teléfono (para debugging)
- ✅ Timestamps, duración de audio, mimetypes
- ✅ Estado de conexión (connected, disconnected, etc.)

Ejemplo de log con `DEBUG=true`:
```
Message received → audio → processing | phoneNumber: "54911..." | duration: 12.5 | mimetype: "audio/ogg"
```
**Nunca**: contenido del audio, transcripción, o texto del mensaje.

### Heartbeat

Cada 30 segundos, el worker loguea las sesiones activas:
```
Heartbeat: 1 session(s) active
  sessionId: "session_abc" status: "connected" phoneNumber: "54911..."
```

### Health Checks

- Worker: `GET /api/status`
- Obfuscated: `GET /api/health`