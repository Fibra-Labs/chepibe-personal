import { awaitBot } from '$lib/server/bot';
import pino from 'pino';

const logger = pino({ level: 'info' });

logger.info('Starting ChepibeBot on server startup...');
awaitBot()
	.then(() => logger.info('ChepibeBot started successfully'))
	.catch((err) => logger.error({ err }, 'ChepibeBot failed to start'));

export const handle = async ({ event, resolve }) => resolve(event);
