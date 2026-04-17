# Voz

Privacy-first WhatsApp audio transcription via Groq AI. Self-hosted, zero logs, open source.

[![License: ChePibe Personal Source](https://img.shields.io/badge/license-ChePibe%20Personal%20Source-blue)](./LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-blue)](./docker-compose.yml)

## Privacy

This system holds **zero logs** of audio content or transcriptions. Audio is processed in-memory and immediately discarded. No transcripts, no recordings, no traces.

## What It Does

Send or receive a voice note on WhatsApp → get back a transcription and concise summary in your own chat. Powered by Groq Whisper (transcription) and Llama (summarization). All in under 10 seconds.

## 🚀 Quick Start (1 Command)

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- A [Groq API key](https://console.groq.com/) (free tier available)

### Setup

```bash
# 1. Clone
git clone https://github.com/fibra-labs/chepibe-personal.git
cd chepibe-personal

# 2. Install
pnpm install

# 3. Configure
cp .env.example .env
```

Edit `.env` — only two values are required:

```bash
# Your WhatsApp number: country code + number, NO + sign
# Argentina example: 5491171234567
# US example: 14155552671
ALLOWED_PHONE=5491171234567

# Get yours at https://console.groq.com/
GROQ_API_KEY=gsk_xxxxxxxx
```

### Start

```bash
pnpm start
```

Open `http://localhost:3000` (or your custom `WEB_PORT`), scan the QR code with WhatsApp, and you're done. Every voice note you send or receive will be transcribed and summarized in your own chat.

### Stop

```bash
pnpm stop
```

### View Logs

```bash
pnpm logs
```

## How It Works

```
Audio comes in → Baileys (WhatsApp) → Groq Whisper (transcription) → 
Groq Llama (summary) → Sent back to YOUR chat
```

- **Your own audios** → transcribed and sent back to you
- **Audio from others** (groups, DMs) → transcribed with sender info, sent to you
- Audio is processed **in-memory** and **never stored**

## Manual Setup (Without Docker)

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) >= 9
- [Groq API key](https://console.groq.com/)

### Install & Run

```bash
git clone https://github.com/fibra-labs/chepibe-personal.git
cd chepibe-personal

pnpm install
cp .env.example .env
# Edit .env with ALLOWED_PHONE and GROQ_API_KEY

# Terminal 1: Worker
pnpm dev:worker

# Terminal 2: Web
# Note: You must pass ALLOWED_PHONE explicitly as SvelteKit only loads .env from packages/web/
ALLOWED_PHONE=$(grep ALLOWED_PHONE .env | cut -d '=' -f2) pnpm dev:web
```

Open `http://localhost:5173` to scan the QR code.

**Note on Environment Variables:** The SvelteKit web app requires `ALLOWED_PHONE` to be available at runtime to display your configured account. In Docker, this is handled automatically. For local development, you must either:
1. Pass it explicitly: `ALLOWED_PHONE=61497369759 pnpm dev:web`
2. Copy `.env` to `packages/web/.env` (SvelteKit loads env from the package root)

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `ALLOWED_PHONE` | **Yes** | Your WhatsApp number (country code + number, no + sign) | — |
| `GROQ_API_KEY` | **Yes** | Groq API key | — |
| `GROQ_WHISPER_MODEL` | No | Whisper model for transcription | `whisper-large-v3` |
| `GROQ_LLM_MODEL` | No | LLM model for summarization | `llama-3.1-8b-instant` |
| `DATABASE_URL` | No | Database URL (local or Turso) | `file:./data/chepibe-personal.db` |
| `DATABASE_PASSWORD` | No | Database password (Turso remote only) | — |
| `PORT` | No | Worker internal port | `3001` |
| `WEB_PORT` | No | Web port exposed to host (Docker) | `3000` |
| `WORKER_PORT` | No | Worker port exposed to host (Docker) | `3001` |
| `WORKER_API_URL` | No | Worker URL for web | `http://localhost:3001` |
| `DEBUG` | No | Enable detailed Baileys logs | `false` |

**Note:** For `pnpm dev:web`, `ALLOWED_PHONE` must be passed explicitly (see Manual Setup section) as SvelteKit only auto-loads `.env` from the package directory, not the monorepo root.

### ALLOWED_PHONE Format

The `ALLOWED_PHONE` is your WhatsApp number in international format **without the + sign**:

| Country | Format | Example |
|---------|--------|---------|
| Argentina | 54 + area + number | `5491171234567` |
| US/Canada | 1 + area + number | `14155552671` |
| Brazil | 55 + area + number | `5511912345678` |
| Spain | 34 + number | `34612345678` |

## Architecture

```
┌─────────────────────┐       ┌─────────────────────────┐
│   Web (SvelteKit)   │  HTTP │   WhatsApp Worker       │
│   Host: WEB_PORT    │◄─────►│   Host: WORKER_PORT     │
│   Container: 3000   │       │   Container: 3001       │
│                     │       │                         │
│  • QR code display  │       │  • Baileys (WhatsApp)   │
│  • Connection status│       │  • Groq Whisper          │
│  • en Español       │       │  • Groq Llama            │
└─────────┬───────────┘       └──────────┬──────────────┘
          │                              │
          ▼                              ▼
    ┌──────────┐                   ┌──────────────┐
    │  SQLite  │                   │  SQLite      │
    │ (local)  │                   │  (Signal Keys)│
    └──────────┘                   └──────────────┘
```

No Redis. No external services besides Groq and WhatsApp.

## Project Structure

```
chepibe-personal/
├── packages/
│   ├── shared/              # DB schema, types, migrations
│   ├── whatsapp-worker/     # Baileys + Groq worker
│   └── web/                 # SvelteKit 5 frontend (en Español)
├── docs/                    # Architecture, Baileys, Security docs
├── docker-compose.yml       # Production (1 command start)
├── .env.example             # Required env vars
└── package.json             # pnpm workspace
```

## Database

The system uses two SQLite tables:

- **`whatsapp_sessions`** — Session metadata and Baileys credentials (for reconnection)
- **`whatsapp_session_keys`** — Signal Protocol keys (one row per key, for message decryption)

Neither table stores audio content, transcriptions, or summaries. See [docs/security.md](docs/security.md) for details.

## Self-Hosting for Production

### Using Turso (Remote SQLite)

For multi-instance or cloud deployment, use [Turso](https://turso.tech/) instead of local SQLite:

```bash
turso db create voz
turso db show voz --url          # → DATABASE_URL
turso db tokens create voz      # → DATABASE_PASSWORD
```

Set both in your `.env` or docker-compose environment.

### Persistent Data with Docker

The docker-compose mounts a local `./data` directory at `/data` for the SQLite database (`data/chepibe-personal.db`). This survives container restarts and rebuilds.

## Development

```bash
pnpm install

# Dev mode (separate terminals)
pnpm dev:worker
pnpm dev:web

# Build all
pnpm build

# Database
pnpm db:generate     # Generate migrations
pnpm db:studio       # Drizzle Studio
```

## License

GNU Affero General Public License v3 — see [LICENSE](./LICENSE).

This project is licensed under the AGPLv3, a strong copyleft license that guarantees your freedom to use, study, modify, and share this software — provided that if you run a modified version over a network, you must make the source code of your modifications available to your users under the same terms. The AGPL ensures source code transparency for all network-facing modifications.

**Commercial use** — If you'd like to use this software commercially without the AGPL's source code sharing requirements, a separate commercial license is available. Contact [fibra@fibra.dev](mailto:fibra@fibra.dev).

## Contributing

Pull requests welcome. For major changes, open an issue first.