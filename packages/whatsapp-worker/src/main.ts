import pino from 'pino';
import { ChepibeBot } from './chepibe-bot/chepibe-bot.js';

const logger = pino({
	transport: {
		target: 'pino-pretty',
		options: { colorize: true },
	},
});

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL;
const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL;
const ALLOWED_PHONE = process.env.ALLOWED_PHONE;

if (!GROQ_API_KEY) {
	logger.fatal('GROQ_API_KEY is required. Set it in .env');
	process.exit(1);
}

if (!ALLOWED_PHONE) {
	logger.fatal('ALLOWED_PHONE is required. Set it in .env (country code + number, no + sign, e.g. 5491171234567)');
	process.exit(1);
}

if (!DATABASE_URL) {
	logger.fatal('DATABASE_URL is required. Set it in .env');
	process.exit(1);
}

if (!GROQ_WHISPER_MODEL) {
	logger.fatal('GROQ_WHISPER_MODEL is required. Set it in .env');
	process.exit(1);
}

if (!GROQ_LLM_MODEL) {
	logger.fatal('GROQ_LLM_MODEL is required. Set it in .env');
	process.exit(1);
}

logger.info(`Configured for phone: ${ALLOWED_PHONE}`);

const bot = new ChepibeBot({
	groqApiKey: GROQ_API_KEY,
	groqWhisperModel: GROQ_WHISPER_MODEL,
	groqLlmModel: GROQ_LLM_MODEL,
	allowedPhone: ALLOWED_PHONE,
	databaseUrl: DATABASE_URL,
	databasePassword: DATABASE_PASSWORD,
	logger,
});

bot.on('QR_READY', ({ sessionId }) => {
	logger.info({ sessionId }, 'Event: QR_READY');
});

bot.on('CONNECTED', ({ sessionId, phoneNumber }) => {
	logger.info({ sessionId, phoneNumber }, 'Event: CONNECTED');
});

bot.on('DISCONNECTED', ({ sessionId, reason }) => {
	logger.info({ sessionId, reason }, 'Event: DISCONNECTED');
});

async function main() {
	await bot.start();

	const shutdown = async () => {
		logger.info('Shutting down...');
		await bot.destroy();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	logger.fatal({ err }, 'Failed to start WhatsApp Worker');
	process.exit(1);
});
