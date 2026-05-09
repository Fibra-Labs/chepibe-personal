import { env } from '$env/dynamic/private';
import pino from 'pino';
import { ChepibeBot } from '@chepibe-personal/whatsapp-worker';

declare global {
	var __chepibeBot: ChepibeBot | undefined;
	var __chepibeStartPromise: Promise<void> | undefined;
}

const DEBUG = env.DEBUG === 'true';

const logger = pino({
	level: DEBUG ? 'debug' : 'info',
	transport: DEBUG
		? { target: 'pino-pretty', options: { colorize: true } }
		: undefined,
});

function validateEnv(): void {
	const missing: string[] = [];
	if (!env.ALLOWED_PHONE) missing.push('ALLOWED_PHONE');
	if (!env.GROQ_API_KEY) missing.push('GROQ_API_KEY');
	if (!env.GROQ_WHISPER_MODEL) missing.push('GROQ_WHISPER_MODEL');
	if (!env.GROQ_LLM_MODEL) missing.push('GROQ_LLM_MODEL');
	if (!env.DATABASE_URL) missing.push('DATABASE_URL');

	if (missing.length > 0) {
		logger.fatal({ missing }, 'Required environment variables are missing');
		process.exit(1);
	}
}

function startBot(): Promise<void> {
	if (globalThis.__chepibeBot) return Promise.resolve();
	if (globalThis.__chepibeStartPromise) return globalThis.__chepibeStartPromise;

	globalThis.__chepibeStartPromise = (async () => {
		validateEnv();
		logger.info('Creating and starting ChepibeBot');
		globalThis.__chepibeBot = new ChepibeBot({
			groqApiKey: env.GROQ_API_KEY!,
			groqWhisperModel: env.GROQ_WHISPER_MODEL!,
			groqLlmModel: env.GROQ_LLM_MODEL!,
			allowedPhone: env.ALLOWED_PHONE!,
			databaseUrl: env.DATABASE_URL!,
			databasePassword: env.DATABASE_PASSWORD,
			logger,
		});
		await globalThis.__chepibeBot.start();
		logger.info('ChepibeBot started');
	})();
	return globalThis.__chepibeStartPromise;
}

async function cleanupBot(): Promise<void> {
	if (!globalThis.__chepibeBot) return;
	logger.info('Cleaning up ChepibeBot');
	await globalThis.__chepibeBot.destroy().catch((err) => logger.error({ err }, 'Failed to clean up ChepibeBot'));
	globalThis.__chepibeBot = undefined;
	globalThis.__chepibeStartPromise = undefined;
}

process.on('SIGINT', async () => {
	void cleanupBot();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	void cleanupBot();
	process.exit(0);
});

export function getBot(): ChepibeBot {
	if (globalThis.__chepibeBot) return globalThis.__chepibeBot;
	void startBot();
	throw new Error('Bot is starting — wait for startup to complete before using getBot()');
}

export function awaitBot(): Promise<ChepibeBot> {
	void startBot();
	return globalThis.__chepibeBot
		? Promise.resolve(globalThis.__chepibeBot)
		: globalThis.__chepibeStartPromise!.then(() => globalThis.__chepibeBot!);
}
