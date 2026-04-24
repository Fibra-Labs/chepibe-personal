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

if (!env.ALLOWED_PHONE) {
	logger.fatal('ALLOWED_PHONE is required');
}
if (!env.GROQ_API_KEY) {
	logger.fatal('GROQ_API_KEY is required');
}
if (!env.GROQ_WHISPER_MODEL) {
	logger.fatal('GROQ_WHISPER_MODEL is required');
}
if (!env.GROQ_LLM_MODEL) {
	logger.fatal('GROQ_LLM_MODEL is required');
}
if (!env.DATABASE_URL) {
	logger.fatal('DATABASE_URL is required');
}

logger.debug({
	allowedPhone: env.ALLOWED_PHONE ? '***' : 'MISSING',
	groqWhisperModel: env.GROQ_WHISPER_MODEL,
	groqLlmModel: env.GROQ_LLM_MODEL,
	databaseUrl: env.DATABASE_URL ? '***' : 'MISSING',
}, 'bot.ts env loaded');

let _bot: ChepibeBot | undefined;
let _startPromise: Promise<void> | undefined;

function startBot(): Promise<void> {
	if (_bot) return Promise.resolve();
	if (_startPromise) return _startPromise;
	_startPromise = (async () => {
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
