import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { Logger } from 'pino';
import type { Client } from '@libsql/client';
import { createDb, runMigrations, whatsappSessions, whatsappSessionKeys } from '@chepibe-personal/shared';
import { eq, sql } from 'drizzle-orm';
import { Mutex } from 'async-mutex';
import { GroqClient } from './groq-client.js';
import { AudioHandler } from './audio-handler.js';
import { WhatsAppSession } from './whatsapp-session.js';
import { BotOptions } from './types.js';
import { SessionStatus } from './types.js';
import type { QRResult } from './types.js';
import { SESSION_ID_PREFIX } from './types.js';

export class ChepibeBot extends EventEmitter {
  private readonly options: BotOptions;
  private readonly logger: Logger;
  private readonly sessionId: string;
  private session: WhatsAppSession | null = null;
  private dbClient: Client | null = null;
  private readonly lock = new Mutex();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: BotOptions) {
    super();
    this.options = options;
    this.sessionId = `${SESSION_ID_PREFIX}${options.allowedPhone}`;
    this.logger = options.logger ?? pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  async start(): Promise<void> {
    const databaseUrl = this.options.databaseUrl;
    const databasePassword = this.options.databasePassword;

    if (databaseUrl.startsWith('file:')) {
      const dbPath = databaseUrl.replace('file:', '');
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const { db, client } = await createDb({ url: databaseUrl, authToken: databasePassword });
    this.dbClient = client;

    this.logger.info('Running database migrations...');
    let migrationsPath = this.options.migrationsPath;

    this.logger.info(`THE MIGRATIONS PATH IS ${migrationsPath}`);

    if (!migrationsPath) {
      try {
        const require = createRequire(import.meta.url);
        const sharedPkgDir = path.dirname(require.resolve('@chepibe-personal/shared/package.json'));
        migrationsPath = path.join(sharedPkgDir, 'drizzle');
      } catch {
        migrationsPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../../drizzle');
        if (!fs.existsSync(migrationsPath)) {
          const fileUrl = new URL('../../drizzle', import.meta.url);
          migrationsPath = fileURLToPath(fileUrl);
        }
      }
    }

    this.logger.info(`FINAL RESOLVED MIGRATIONS PATH: ${migrationsPath}`);
    if (!fs.existsSync(migrationsPath)) {
      throw new Error(`CRITICAL STOP: Migrations folder does not exist at ${migrationsPath}`);
    }
    const migrationFiles = fs.readdirSync(migrationsPath).filter(f => f.endsWith('.sql'));
    this.logger.info(`Found ${migrationFiles.length} .sql files in migrations folder.`);
    if (migrationFiles.length === 0) {
      throw new Error(`CRITICAL STOP: Migrations folder exists, but has NO .sql files!`);
    }

    await runMigrations(db, migrationsPath);
    this.logger.info('Database migrations completed');

    const groqClient = new GroqClient(
      this.options.groqApiKey,
      this.options.groqWhisperModel,
      this.options.groqLlmModel,
      this.logger,
    );
    const audioHandler = new AudioHandler(groqClient, this.logger);
    this.session = new WhatsAppSession(
      this.sessionId,
      db,
      client,
      audioHandler,
      this.logger,
      this.options.allowedPhone,
      (event) => {
        this.emit(event.type, event.payload);
      },
    );

    this.logger.info('Cleaning up ghost sessions from database...');
    const ghostRows = await db.delete(whatsappSessions)
      .where(sql`${whatsappSessions.id} != ${this.sessionId}`)
      .returning({ id: whatsappSessions.id });
    if (ghostRows.length > 0) {
      this.logger.info(`Deleted ${ghostRows.length} ghost session(s): ${ghostRows.map((r: { id: string }) => r.id).join(', ')}`);
      await db.delete(whatsappSessionKeys).where(sql`${whatsappSessionKeys.sessionId} != ${this.sessionId}`);
    }

    this.logger.info('Checking for existing session in database...');
    const sessionRows = await db.select().from(whatsappSessions)
      .where(eq(whatsappSessions.id, this.sessionId))
      .limit(1);

    if (sessionRows.length > 0 && sessionRows[0].creds) {
      const status = sessionRows[0].status;
      this.logger.info(`Found session with status: ${status}`);

      if (status === SessionStatus.Connected) {
        this.logger.info('Attempting to restore connected session...');
        await this.session.reconnect();
      } else {
        this.logger.info(`Session status is '${status}' (not connected), deleting stale session data and starting fresh...`);
        await db.delete(whatsappSessionKeys).where(eq(whatsappSessionKeys.sessionId, this.sessionId));
        await db.delete(whatsappSessions).where(eq(whatsappSessions.id, this.sessionId));
      }
    }

    this.startHeartbeat(30000);

    this.logger.info(
      this.session
        ? `Session active: ${this.session.sessionId} (${this.session.getStatus()}${this.session.getPhoneNumber() ? ` ${this.session.getPhoneNumber()}` : ''})`
        : 'No active session',
    );
  }

  async getQR(): Promise<QRResult> {
    if (!this.session) {
      throw new Error('Bot not started. Call start() first.');
    }

    const { db } = await createDb({
      url: this.options.databaseUrl,
      authToken: this.options.databasePassword,
    });

    const sessionRows = await db.select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, this.sessionId))
      .limit(1);

    if (sessionRows.length > 0 && sessionRows[0].status === SessionStatus.Connected) {
      this.logger.info('Blocking getQR(): session is connected in DB');
      return {
        alreadyConnected: true,
        sessionId: this.sessionId,
        phoneNumber: sessionRows[0].phoneNumber ?? undefined,
      };
    }

    if (this.session && this.session.getStatus() === SessionStatus.Connected) {
      return {
        alreadyConnected: true,
        sessionId: this.session.sessionId,
        phoneNumber: this.session.getPhoneNumber() ?? undefined,
      };
    }

    await this.destroySession();
    if (!this.session) {
      throw new Error('Session destroyed but not recreated');
    }
    const qrResult = await this.session.startQR();
    if (!qrResult.ok) {
      throw qrResult.error;
    }
    return { qrCode: qrResult.value.qrCode, sessionId: this.sessionId, alreadyConnected: false };
  }

  getStatus(): { connected: boolean; phoneNumber: string | null } {
    if (!this.session) {
      throw new Error('Bot not started. Call start() first.');
    }

    if (!this.session) {
      return { connected: false, phoneNumber: null };
    }

    return {
      connected: this.session.getStatus() === SessionStatus.Connected,
      phoneNumber: this.session.getPhoneNumber(),
    };
  }

  async requestPairingCode(phoneNumber: string): Promise<{ code: string; sessionId: string }> {
    if (!this.session) {
      throw new Error('Bot not started. Call start() first.');
    }

    const { db } = await createDb({
      url: this.options.databaseUrl,
      authToken: this.options.databasePassword,
    });

    const sessionRows = await db.select()
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, this.sessionId))
      .limit(1);

    if (sessionRows.length > 0 && sessionRows[0].status === SessionStatus.Connected) {
      this.logger.error('Blocking requestPairingCode(): session is connected in DB');
      throw new Error('Cannot request pairing code: session is already connected');
    }

    await this.destroySession();
    if (!this.session) {
      throw new Error('Session destroyed but not recreated');
    }

    const pairingResult = await this.session.startPairing(phoneNumber);
    if (!pairingResult.ok) {
      throw pairingResult.error;
    }
    return { code: pairingResult.value.code, sessionId: this.sessionId };
  }

  async disconnect(): Promise<void> {
    if (!this.session) {
      throw new Error('Bot not started. Call start() first.');
    }
    const result = await this.session.destroy();
    if (!result.ok) {
      throw result.error;
    }
  }

  async destroy(): Promise<void> {
    this.stopHeartbeat();

    if (this.session) {
      await this.session.destroy();
      this.session = null;
    }

    if (this.dbClient) {
      try {
        this.dbClient.close();
      } catch (err) {
        this.logger.error({ err }, 'Error closing database client');
      } finally {
        this.dbClient = null;
      }
    }
  }

  private async destroySession(): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (!this.session) return;
      await this.session.destroy();
      this.session = null;
    });
  }

  private startHeartbeat(intervalMs = 30000): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.session) {
        this.logger.info(
          { sessionId: this.session.sessionId, status: this.session.getStatus(), phoneNumber: this.session.getPhoneNumber() },
          `Heartbeat: 1 session active`,
        );
      } else {
        this.logger.info([], `Heartbeat: 0 sessions active`);
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
