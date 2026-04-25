import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { Logger } from 'pino';
import { createDb, runMigrations } from '@chepibe-personal/shared';
import { GroqClient } from '../infrastructure/groq/groq-client.js';
import { AudioHandler } from '../infrastructure/groq/audio-handler.js';
import { BaileysConnectionManager } from '../infrastructure/whatsapp/baileys-connection.manager.js';
import type { BaileysSession } from '../types/baileys-session.js';
import type { ChepibeBotOptions } from './chepibe-bot-options.js';
import type { QRResult } from './qr-result.js';

export class ChepibeBot extends EventEmitter {
	private readonly options: ChepibeBotOptions;
	private readonly logger: Logger;
	private connectionManager: BaileysConnectionManager | null = null;

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

		this.logger.info('Running database migrations...');
		let migrationsPath = this.options.migrationsPath;
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
		await runMigrations(db, migrationsPath);
		this.logger.info('Database migrations completed');

		const groqClient = new GroqClient(
			this.options.groqApiKey,
			this.options.groqWhisperModel,
			this.options.groqLlmModel,
			this.logger,
		);
		const audioHandler = new AudioHandler(groqClient, this.logger);
		this.connectionManager = new BaileysConnectionManager(db, client, audioHandler, this.logger, this.options.allowedPhone);

		this.connectionManager.on('QR_READY', (data: { sessionId: string; qrCode: string }) => {
			this.emit('QR_READY', data);
		});
		this.connectionManager.on('CONNECTED', (data: { sessionId: string; phoneNumber: string }) => {
			this.emit('CONNECTED', data);
		});
		this.connectionManager.on('DISCONNECTED', (data: { sessionId: string; reason: string }) => {
			this.emit('DISCONNECTED', data);
		});

		this.logger.info('Restoring sessions from database...');
		await this.connectionManager.restoreSessions();
		this.connectionManager.startHeartbeat(30000);

		const sessions = this.connectionManager.getSessions();
		this.logger.info(
			`${sessions.length} session(s) restored: ${sessions.map(s => `${s.sessionId} (${s.status}${s.phoneNumber ? ` ${s.phoneNumber}` : ''})`).join(', ') || 'none'}`,
		);
	}

	async getQR(sessionId?: string): Promise<QRResult> {
		if (!this.connectionManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const sessions = this.connectionManager.getSessions();
		const existingConnected = sessions.find(s => s.status === 'connected');

		if (existingConnected) {
			return {
				alreadyConnected: true,
				sessionId: existingConnected.sessionId,
				phoneNumber: existingConnected.phoneNumber,
				qrCode: existingConnected.qrCode,
			};
		}

		const id = sessionId || `session_${Date.now()}`;
		const { qrCode } = await this.connectionManager.createConnection(id);
		return { qrCode, sessionId: id, alreadyConnected: false };
	}

	getStatus(): {
		connected: boolean;
		phoneNumber: string | null;
		sessions: Array<{ sessionId: string; status: string; phoneNumber?: string; createdAt: Date }>;
	} {
		if (!this.connectionManager) {
			throw new Error('Bot not started. Call start() first.');
		}

		const sessions = this.connectionManager.getSessions();
		const connected = sessions.some(s => s.status === 'connected');
		const primarySession = sessions.find(s => s.status === 'connected');

		return {
			connected,
			phoneNumber: primarySession?.phoneNumber ?? null,
			sessions: sessions.map(s => ({
				sessionId: s.sessionId,
				status: s.status,
				phoneNumber: s.phoneNumber,
				createdAt: s.createdAt,
			})),
		};
	}

	getSessions(): BaileysSession[] {
		if (!this.connectionManager) {
			throw new Error('Bot not started. Call start() first.');
		}
		return this.connectionManager.getSessions();
	}

	async disconnect(sessionId: string): Promise<void> {
		if (!this.connectionManager) {
			throw new Error('Bot not started. Call start() first.');
		}
		await this.connectionManager.disconnectSession(sessionId);
	}

	async destroy(): Promise<void> {
		if (this.connectionManager) {
			await this.connectionManager.destroy();
			this.connectionManager = null;
		}
	}
}
