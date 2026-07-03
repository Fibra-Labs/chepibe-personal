import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { Logger } from 'pino';
import type { Client } from '@libsql/client';
import { createDb, runMigrations, whatsappSessions, whatsappSessionKeys, type Db } from '@chepibe-personal/shared';
import { eq, sql } from 'drizzle-orm';
import { Mutex } from 'async-mutex';
import { GroqClient } from './groq-client.js';
import { AudioHandler } from './audio-handler.js';
import { WhatsAppSession } from './whatsapp-session.js';
import type { BotOptions, QRResult, PasskeySubmitPayload } from './types.js';
import { SessionStatus, SESSION_ID_PREFIX, type PairingStep, type Result } from './types.js';

export class ChepibeBot extends EventEmitter {
  private readonly options: BotOptions;
  private readonly logger: Logger;
  private readonly sessionId: string;
  private session: WhatsAppSession | null = null;
  private db: Db | null = null;
  private client: Client | null = null;
  private audioHandler: AudioHandler | null = null;
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
    this.db = db;
    this.client = client;

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
    this.audioHandler = new AudioHandler(groqClient, this.logger);
    this.session = this.createSession();

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
      this.logger.info({ status: sessionRows[0].status }, 'Found existing session credentials, attempting to restore...');
      await this.session.reconnect();
    }

    this.startHeartbeat(30000);

    this.logger.info(
        `Session active: ${this.session.sessionId} (${this.session.getStatus()}${this.session.getPhoneNumber() ? ` ${this.session.getPhoneNumber()}` : ''})`,
    );
  }

  async getQR(): Promise<QRResult> {
    if (!this.session || !this.db) {
      throw new Error('Bot not started. Call start() first.');
    }

    const sessionRows = await this.db.select()
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

    if (this.session.getStatus() === SessionStatus.Connected) {
      return {
        alreadyConnected: true,
        sessionId: this.session.sessionId,
        phoneNumber: this.session.getPhoneNumber() ?? undefined,
      };
    }

    await this.destroyAndRecreateSession();
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

    return {
      connected: this.session.getStatus() === SessionStatus.Connected,
      phoneNumber: this.session.getPhoneNumber(),
    };
  }

  async requestPairingCode(phoneNumber: string): Promise<{ code: string; sessionId: string }> {
    if (!this.session || !this.db) {
      throw new Error('Bot not started. Call start() first.');
    }

    const sessionRows = await this.db.select()
        .from(whatsappSessions)
        .where(eq(whatsappSessions.id, this.sessionId))
        .limit(1);

    if (sessionRows.length > 0 && sessionRows[0].status === SessionStatus.Connected) {
      this.logger.error('Blocking requestPairingCode(): session is connected in DB');
      throw new Error('Cannot request pairing code: session is already connected');
    }

    await this.destroyAndRecreateSession();
    const pairingResult = await this.session.startPairing(phoneNumber);
    if (!pairingResult.ok) {
      throw pairingResult.error;
    }
    return { code: pairingResult.value.code, sessionId: this.sessionId };
  }

  async submitPasskeyResponse(payload: PasskeySubmitPayload): Promise<Result<void>> {
    if (!this.session) {
      return { ok: false, error: new Error('Bot not started. Call start() first.') };
    }
    return this.session.submitPasskeyResponse(payload);
  }

  async submitPasskeyConfirmation(): Promise<Result<void>> {
    if (!this.session) {
      return { ok: false, error: new Error('Bot not started. Call start() first.') };
    }
    return this.session.submitConfirmation();
  }

  getPairingStep(): PairingStep {
    if (!this.session) {
      throw new Error('Bot not started. Call start() first.');
    }
    return this.session.getPairingStep();
  }

  async disconnect(): Promise<void> {
    if (!this.session) {
      throw new Error('Bot not started. Call start() first.');
    }
    await this.destroyAndRecreateSession();
  }

  async suspend(): Promise<void> {
    this.stopHeartbeat();

    if (this.session) {
      await this.session.stop();
      this.session = null;
    }
  }

  async destroy(): Promise<void> {
    this.stopHeartbeat();

    if (this.session) {
      await this.session.destroy();
      this.session = null;
    }

    if (this.client) {
      try {
        this.client.close();
      } catch (err) {
        this.logger.error({ err }, 'Error closing database client');
      } finally {
        this.client = null;
      }
    }
  }

  private createSession(): WhatsAppSession {
    if (!this.db || !this.client || !this.audioHandler) {
      throw new Error('Cannot create session: bot not initialized');
    }
    return new WhatsAppSession(
        this.sessionId,
        this.db,
        this.client,
        this.audioHandler,
        this.logger,
        this.options.allowedPhone,
        (event) => {
          this.emit(event.type, event.payload);
        },
    );
  }

  private async destroyAndRecreateSession(): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (this.session) {
        await this.session.destroy();
      }
      this.session = this.createSession();
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
