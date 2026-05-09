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
import { GroqClient } from '../infrastructure/groq/groq-client.js';
import { AudioHandler } from '../infrastructure/groq/audio-handler.js';
import { SingleSessionManager } from '../infrastructure/whatsapp/single-session-manager.js';
import { SessionActor } from '../domain/session-actor.js';
import type { ChepibeBotOptions } from './chepibe-bot-options.js';
import type { QRResult } from './qr-result.js';
import { SessionState } from '../constants/session.constants.js';

const SESSION_ID_PREFIX = 'session_';

export class ChepibeBot extends EventEmitter {
	private readonly options: ChepibeBotOptions;
	private readonly logger: Logger;
	private readonly sessionId: string;
	private sessionManager: SingleSessionManager | null = null;
	private dbClient: Client | null = null;

	constructor(options: ChepibeBotOptions) {
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
		this.sessionManager = new SingleSessionManager(
			(sessionId) => new SessionActor(
				sessionId,
				db,
				client,
				audioHandler,
				this.logger,
				this.options.allowedPhone,
				(event) => {
					this.emit(event.type, event.payload);
				},
			),
			this.logger,
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

			if (status === 'connected') {
				this.logger.info('Attempting to restore connected session...');
				const result = this.sessionManager.getOrCreateSession(this.sessionId);
				if (result.ok) {
					await result.value.reconnect();
				}
			} else {
				this.logger.info(`Session status is '${status}' (not connected), deleting stale session data and starting fresh...`);
				await db.delete(whatsappSessionKeys).where(eq(whatsappSessionKeys.sessionId, this.sessionId));
				await db.delete(whatsappSessions).where(eq(whatsappSessions.id, this.sessionId));
			}
		}

		this.sessionManager.startHeartbeat(30000);

		const actor = this.sessionManager.getSession();
		this.logger.info(
			actor
				? `Session active: ${actor.sessionId} (${actor.getStatus()}${actor.getPhoneNumber() ? ` ${actor.getPhoneNumber()}` : ''})`
				: 'No active session',
		);
	}

	async getQR(): Promise<QRResult> {
		if (!this.sessionManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const { db } = await createDb({
			url: this.options.databaseUrl,
			authToken: this.options.databasePassword
		});

		const sessionRows = await db.select()
			.from(whatsappSessions)
			.where(eq(whatsappSessions.id, this.sessionId))
			.limit(1);

		if (sessionRows.length > 0 && sessionRows[0].status === 'connected') {
			this.logger.info('Blocking getQR(): session is connected in DB');
			return {
				alreadyConnected: true,
				sessionId: this.sessionId,
				phoneNumber: sessionRows[0].phoneNumber ?? undefined,
			};
		}

		const actor = this.sessionManager.getSession();
		if (actor && actor.getStatus() === SessionState.Connected) {
			return {
				alreadyConnected: true,
				sessionId: actor.sessionId,
				phoneNumber: actor.getPhoneNumber() ?? undefined,
			};
		}

		await this.sessionManager.destroySession();
		const createResult = this.sessionManager.getOrCreateSession(this.sessionId);
		if (!createResult.ok) {
			throw new Error(`Failed to create session: ${createResult.error.message}`);
		}
		const qrResult = await createResult.value.startQR();
		if (!qrResult.ok) {
			throw qrResult.error;
		}
		return { qrCode: qrResult.value.qrCode, sessionId: this.sessionId, alreadyConnected: false };
	}

	getStatus(): { connected: boolean; phoneNumber: string | null } {
		if (!this.sessionManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const actor = this.sessionManager.getSession();
		if (!actor) {
			return { connected: false, phoneNumber: null };
		}

		return {
			connected: actor.getStatus() === SessionState.Connected,
			phoneNumber: actor.getPhoneNumber(),
		};
	}

	async requestPairingCode(phoneNumber: string): Promise<{ code: string; sessionId: string }> {
		if (!this.sessionManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const { db } = await createDb({
			url: this.options.databaseUrl,
			authToken: this.options.databasePassword
		});

		const sessionRows = await db.select()
			.from(whatsappSessions)
			.where(eq(whatsappSessions.id, this.sessionId))
			.limit(1);

		if (sessionRows.length > 0 && sessionRows[0].status === 'connected') {
			this.logger.error('Blocking requestPairingCode(): session is connected in DB');
			throw new Error('Cannot request pairing code: session is already connected');
		}

		await this.sessionManager.destroySession();
		const createResult = this.sessionManager.getOrCreateSession(this.sessionId);
		if (!createResult.ok) {
			throw new Error(`Failed to create session: ${createResult.error.message}`);
		}

		const pairingResult = await createResult.value.startPairing(phoneNumber);
		if (!pairingResult.ok) {
			throw pairingResult.error;
		}
		return { code: pairingResult.value.code, sessionId: this.sessionId };
	}

	async disconnect(): Promise<void> {
		if (!this.sessionManager) {
			throw new Error('Bot not started. Call start() first.');
		}
		const result = await this.sessionManager.destroySession();
		if (!result.ok) {
			throw result.error;
		}
	}

	async destroy(): Promise<void> {
		if (this.sessionManager) {
			await this.sessionManager.destroy();
			this.sessionManager = null;
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
}