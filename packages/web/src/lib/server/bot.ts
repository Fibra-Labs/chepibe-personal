import { env } from '$env/dynamic/private';
import pino from 'pino';
import { ChepibeBot } from '@chepibe-personal/whatsapp-worker';

const DEBUG = env.DEBUG === 'true';

const logger = pino({
	level: DEBUG ? 'debug' : 'info',
	transport: DEBUG
		? { target: 'pino-pretty', options: { colorize: true } }
		: undefined,
});

let _bot: ChepibeBot | undefined;
let _startPromise: Promise<void> | undefined;

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
	if (_bot) return Promise.resolve();
	if (_startPromise) return _startPromise;
	_startPromise = (async () => {
		validateEnv();
		logger.debug('Creating and starting ChepibeBot');
		_bot = new ChepibeBot({
			groqApiKey: env.GROQ_API_KEY!,
			groqWhisperModel: env.GROQ_WHISPER_MODEL!,
			groqLlmModel: env.GROQ_LLM_MODEL!,
			allowedPhone: env.ALLOWED_PHONE!,
			databaseUrl: env.DATABASE_URL!,
			databasePassword: env.DATABASE_PASSWORD,
			logger,
		});
		await _bot.start();
		logger.info('ChepibeBot started');
	})();
	return _startPromise;
}

export function getBot(): ChepibeBot {
	if (_bot) return _bot;
	void startBot();
	throw new Error('Bot is starting — wait for startup to complete before using getBot()');
}

export function awaitBot(): Promise<ChepibeBot> {
	void startBot();
	return _bot ? Promise.resolve(_bot) : _startPromise!.then(() => _bot!);
}
