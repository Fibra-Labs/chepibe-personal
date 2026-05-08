import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { Logger } from 'pino';
import type { Client } from '@libsql/client';
import { createDb, runMigrations, whatsappSessions } from '@chepibe-personal/shared';
import { GroqClient } from '../infrastructure/groq/groq-client.js';
import { AudioHandler } from '../infrastructure/groq/audio-handler.js';
import { SocketManager } from '../infrastructure/whatsapp/socket-manager.js';
import { SessionActor } from '../domain/session-actor.js';
import type { BaileysSession } from '../types/baileys-session.js';
import type { ChepibeBotOptions } from './chepibe-bot-options.js';
import type { QRResult } from './qr-result.js';

export class ChepibeBot extends EventEmitter {
	private readonly options: ChepibeBotOptions;
	private readonly logger: Logger;
	private socketManager: SocketManager | null = null;
	private dbClient: Client | null = null;

	constructor(options: ChepibeBotOptions) {
		super();
		this.options = options;
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
		this.socketManager = new SocketManager(
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

		this.logger.info('Restoring sessions from database...');
		const sessionRows = await db.select().from(whatsappSessions);
		for (const row of sessionRows) {
			if (row.creds) {
				const result = await this.socketManager.createSession(row.id);
				if (result.ok) {
					await result.value.reconnect();
				}
			}
		}
		this.socketManager.startHeartbeat(30000);

		const sessions = this.socketManager.getActors();
		this.logger.info(
			`${sessions.length} session(s) restored: ${sessions.map(s => `${s.sessionId} (${s.getStatus()}${s.getPhoneNumber() ? ` ${s.getPhoneNumber()}` : ''})`).join(', ') || 'none'}`,
		);
	}

	async getQR(sessionId?: string): Promise<QRResult> {
		if (!this.socketManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const actors = this.socketManager.getActors();
		const existingConnected = actors.find(a => a.getStatus() === 'connected');

		if (existingConnected) {
			return {
				alreadyConnected: true,
				sessionId: existingConnected.sessionId,
				phoneNumber: existingConnected.getPhoneNumber() ?? undefined,
			};
		}

		const id = sessionId || `session_${Date.now()}`;
		const createResult = await this.socketManager.createSession(id);
		if (!createResult.ok) {
			throw new Error(`Failed to create session: ${createResult.error.message}`);
		}
		const qrResult = await createResult.value.startQR();
		if (!qrResult.ok) {
			throw qrResult.error;
		}
		return { qrCode: qrResult.value.qrCode, sessionId: id, alreadyConnected: false };
	}

	getStatus(): {
		connected: boolean;
		phoneNumber: string | null;
		sessions: Array<{ sessionId: string; status: string; phoneNumber?: string; createdAt: Date }>;
	} {
		if (!this.socketManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const actors = this.socketManager.getActors();
		const connected = actors.some(a => a.getStatus() === 'connected');
		const primarySession = actors.find(a => a.getStatus() === 'connected');

		return {
			connected,
			phoneNumber: primarySession?.getPhoneNumber() ?? null,
			sessions: actors.map(a => ({
				sessionId: a.sessionId,
				status: a.getStatus(),
				phoneNumber: a.getPhoneNumber() ?? undefined,
				createdAt: new Date(),
			})),
		};
	}

	getSessions(): BaileysSession[] {
		if (!this.socketManager) {
			throw new Error('Bot not started. Call start() first.');
		}
		return this.socketManager.getActors().map(a => ({
			sessionId: a.sessionId,
			socket: undefined as any,
			status: a.getStatus(),
			phoneNumber: a.getPhoneNumber() ?? undefined,
			createdAt: new Date(),
			lastActivityAt: new Date(),
		}));
	}

	async requestPairingCode(sessionId: string, phoneNumber: string): Promise<{ code: string; sessionId: string }> {
		if (!this.socketManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const id = sessionId || `session_${Date.now()}`;
		const createResult = await this.socketManager.createSession(id);
		if (!createResult.ok) {
			throw new Error(`Failed to create session: ${createResult.error.message}`);
		}

		const pairingResult = await createResult.value.startPairing(phoneNumber);
		if (!pairingResult.ok) {
			throw pairingResult.error;
		}
		return { code: pairingResult.value.code, sessionId: id };
	}

	async disconnect(sessionId: string): Promise<void> {
		if (!this.socketManager) {
			throw new Error('Bot not started. Call start() first.');
		}
		const result = await this.socketManager.destroySession(sessionId);
		if (!result.ok) {
			throw result.error;
		}
	}

	async destroy(): Promise<void> {
		if (this.socketManager) {
			await this.socketManager.destroy();
			this.socketManager = null;
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
