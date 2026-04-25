import type { Logger } from 'pino';

export interface ChepibeBotOptions {
	groqApiKey: string;
	groqWhisperModel: string;
	groqLlmModel: string;
	allowedPhone: string;
	databaseUrl: string;
	databasePassword?: string;
	logger?: Logger;
	migrationsPath?: string;
}
