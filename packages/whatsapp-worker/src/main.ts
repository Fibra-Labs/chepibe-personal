import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import pino from 'pino';
import { createDb, runMigrations } from '@chepibe-personal/shared';
import { GroqClient } from './infrastructure/groq/groq-client.js';
import { AudioHandler } from './infrastructure/groq/audio-handler.js';
import { BaileysConnectionManager } from './infrastructure/whatsapp/baileys-connection.manager.js';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

const DATABASE_URL = process.env.DATABASE_URL || 'file:../../data/chepibe-personal.db';
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD || undefined;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL || 'llama-3.1-8b-instant';
const ALLOWED_PHONE = process.env.ALLOWED_PHONE || '';
const PORT = parseInt(process.env.WORKER_PORT || '3001', 10);

if (!GROQ_API_KEY) {
  logger.fatal('GROQ_API_KEY is required. Set it in .env');
  process.exit(1);
}

if (!ALLOWED_PHONE) {
  logger.fatal('ALLOWED_PHONE is required. Set it in .env (country code + number, no + sign, e.g. 5491171234567)');
  process.exit(1);
}

logger.info(`Configured for phone: ${ALLOWED_PHONE}`);

async function main() {
  logger.info('Starting WhatsApp Worker...');

  if (DATABASE_URL.startsWith('file:')) {
    const dbPath = DATABASE_URL.replace('file:', '');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = createDb({ url: DATABASE_URL, authToken: DATABASE_PASSWORD });
  
  logger.info('Running database migrations...');
  const require = createRequire(import.meta.url);
  const sharedPkgDir = path.dirname(require.resolve('@chepibe-personal/shared/package.json'));
  const migrationsPath = path.join(sharedPkgDir, 'drizzle');
  await runMigrations(db, migrationsPath);
  logger.info('Database migrations completed');

  const groqClient = new GroqClient(GROQ_API_KEY, GROQ_WHISPER_MODEL, GROQ_LLM_MODEL, logger);
  const audioHandler = new AudioHandler(groqClient, logger);
  const connectionManager = new BaileysConnectionManager(db, audioHandler, logger, ALLOWED_PHONE);

  logger.info('Restoring sessions from database...');
  await connectionManager.restoreSessions();
  connectionManager.startHeartbeat(30000);

  const sessions = connectionManager.getSessions();
  logger.info(`${sessions.length} session(s) restored: ${sessions.map(s => `${s.sessionId} (${s.status}${s.phoneNumber ? ` ${s.phoneNumber}` : ''})`).join(', ') || 'none'}`);

  connectionManager.on('QR_READY', ({ sessionId, qrCode }) => {
    logger.info({ sessionId }, 'Event: QR_READY');
  });
  connectionManager.on('CONNECTED', ({ sessionId, phoneNumber }) => {
    logger.info({ sessionId, phoneNumber }, 'Event: CONNECTED');
  });
  connectionManager.on('DISCONNECTED', ({ sessionId, reason }) => {
    logger.info({ sessionId, reason }, 'Event: DISCONNECTED');
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/qr') {
      try {
        const sessions = connectionManager.getSessions();
        const existingConnected = sessions.find(s => s.status === 'connected');

        if (existingConnected) {
          const qrDataUrl = await QRCode.toDataURL(existingConnected.qrCode || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            sessionId: existingConnected.sessionId,
            qrCode: existingConnected.qrCode,
            qrDataUrl,
            alreadyConnected: true,
            phoneNumber: existingConnected.phoneNumber,
          }));
          return;
        }

        const sessionId = url.searchParams.get('sessionId') || `session_${Date.now()}`;
        const { qrCode } = await connectionManager.createConnection(sessionId);
        const qrDataUrl = await QRCode.toDataURL(qrCode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId, qrCode, qrDataUrl }));
      } catch (err: any) {
        logger.error({ err }, 'Failed to create QR');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      const sessions = connectionManager.getSessions();
      const connected = sessions.some(s => s.status === 'connected');
      const primarySession = sessions.find(s => s.status === 'connected');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected,
        phoneNumber: primarySession?.phoneNumber ?? null,
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          status: s.status,
          phoneNumber: s.phoneNumber,
          createdAt: s.createdAt,
        })),
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      const sessions = connectionManager.getSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions.map(s => ({
        sessionId: s.sessionId,
        status: s.status,
        phoneNumber: s.phoneNumber,
        createdAt: s.createdAt,
      }))));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/disconnect') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionId } = JSON.parse(body || '{}');
          if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sessionId required' }));
            return;
          }
          await connectionManager.disconnectSession(sessionId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    logger.info(`WhatsApp Worker listening on port ${PORT}`);
  });

  const shutdown = async () => {
    logger.info('Shutting down...');
    await connectionManager.destroy();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start WhatsApp Worker');
  process.exit(1);
});
