# Che Pibe Personal - WhatsApp Audio Transcription Service

## Overview

Che Pibe Personal es un servicio de transcripción de audio de WhatsApp diseñado con privacidad primaria. Conectás tu WhatsApp vía código QR, y cada nota de voz que recibís se transcribe y resume automáticamente. El resultado se envía a tu propio chat — sin que el sistema almacene **ningún contenido**.

## What Is This?

Che Pibe Personal consta de dos componentes principales:

1. **Web App (SvelteKit 5)** - Interfaz web para escanear el código QR de WhatsApp y monitorear el estado de la conexión
2. **WhatsApp Worker (Node.js)** - Procesa mensajes de audio entrantes vía Baileys, transcribe con Groq Whisper, resume con Groq Llama, y envía el resultado al usuario conectado

## Key Features

- **🔒 Privacy-First**: Cero almacenamiento de audio, transcripciones o contenido del usuario
- **🤖 IA Integration**: Groq Whisper (`whisper-large-v3`) para transcripción, Llama (`llama-3.1-8b-instant`) para resúmenes
- **🇦🇷 Optimizado para Argentina**: Transcripción y resúmenes en español argentino
- **📱 WhatsApp Nativo**: Integración vía Baileys v7 - sin APIs oficiales
- **🔁 Resiliente**: Sesiones sobreviven restarts del worker (creds + signal keys persistidos en SQLite)
- **🐳 Docker-Ready**: Despliegue simple con Docker Compose
- **☁️ Self-Hosted**: Tu código, tu infraestructura, tu control

## Quick Start

### Prerequisitos

- Node.js ≥ 22
- pnpm ≥ 9
- Groq API key

### Instalación

```bash
git clone https://github.com/fibra-labs/chepibe-personal.git
cd chepibe-personal

pnpm install

cp .env.example .env
# Editar .env con tu GROQ_API_KEY

# Iniciar servicios (en terminales separados)
pnpm dev:worker
pnpm dev:web
```

### Primer Uso

1. Abrir http://localhost:5173
2. Click en "Conectar WhatsApp"
3. Escanear código QR con WhatsApp en tu teléfono
4. Enviar una nota de voz a cualquier chat donde estés
5. Recibir transcripción y resumen en tu propio chat automáticamente

### Cómo Funciona

```
Alguien envía audio → Baileys lo recibe → Descarga audio → Groq Whisper transcribe → 
Groq Llama resume → Se envía transcripción + resumen al usuario conectado
```

El audio se procesa **en memoria** y se descarta inmediatamente. No hay base de datos de audios ni transcripciones.

## Estructura del Proyecto

```
chepibe-personal/
├── packages/
│   ├── shared/              # Esquema DB, migraciones, tipos
│   ├── whatsapp-worker/     # Worker de Baileys + Groq
│   └── web/                 # Frontend SvelteKit 5
├── docs/                    # Documentación
├── docker-compose.yml       # Producción
└── .env.example             # Variables de entorno
```

## Environment Variables

| Variable | Descripción | Default |
|----------|-------------|---------|
| `DATABASE_URL` | URL de la base de datos SQLite/Turso | `file:./data/chepibe-personal.db` |
| `DATABASE_PASSWORD` | Token de autenticación Turso (solo remoto) | - |
| `GROQ_API_KEY` | API key de Groq | - |
| `GROQ_WHISPER_MODEL` | Modelo de transcripción | `whisper-large-v3` |
| `GROQ_LLM_MODEL` | Modelo de resumen | `llama-3.1-8b-instant` |
| `PORT` | Puerto interno del worker | `3001` |
| `WEB_PORT` | Puerto del web expuesto al host (Docker) | `3000` |
| `WORKER_PORT` | Puerto del worker expuesto al host (Docker) | `3001` |
| `WORKER_API_URL` | URL del worker para el web | `http://localhost:3001` |
| `DEBUG` | Activar logs detallados de Baileys | `false` |
| `NODE_ENV` | Ambiente | `development` |

## Licencia

ChePibe Personal Source License - uso personal gratuito, comercial requiere licencia separada.