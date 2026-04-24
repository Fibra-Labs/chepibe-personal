import { awaitBot } from '$lib/server/bot';
import { config } from '$lib/server/config';
import { env } from '$env/dynamic/private';
import pino from 'pino';
import type { Actions } from '@sveltejs/kit';

const logger = pino({
	level: env.DEBUG === 'true' ? 'debug' : 'error',
	transport: env.DEBUG === 'true'
		? { target: 'pino-pretty', options: { colorize: true } }
		: undefined,
});

export const load = async () => {
	try {
		const bot = await awaitBot();
		const data = bot.getStatus();
		return {
			connected: data.connected ?? false,
			phoneNumber: data.phoneNumber ?? null,
			sessionId: data.sessions?.find((s: { status: string }) => s.status === 'connected')?.sessionId ?? data.sessions?.[0]?.sessionId ?? null,
			allowedPhone: config.allowedPhone
		};
	} catch (err) {
		logger.error({ err }, 'Home page load failed');
		return {
			connected: false,
			phoneNumber: null,
			sessionId: null,
			allowedPhone: config.allowedPhone
		};
	}
};

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const sessionId = data.get('sessionId')?.toString();
		try {
			const bot = await awaitBot();
		if (sessionId) {
			await bot.disconnect(sessionId);
		}
		} catch (err) {
			logger.error({ err, sessionId }, 'Disconnect action failed');
		}
		return { success: true };
	}
};
