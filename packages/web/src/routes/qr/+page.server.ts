import { awaitBot } from '$lib/server/bot';
import { env } from '$env/dynamic/private';
import pino from 'pino';
import type { ServerLoad } from '@sveltejs/kit';

const logger = pino({
	level: env.DEBUG === 'true' ? 'debug' : 'error',
	transport: env.DEBUG === 'true'
		? { target: 'pino-pretty', options: { colorize: true } }
		: undefined,
});

export const load: ServerLoad = async ({ url }) => {
	try {
		const sessionId = url.searchParams.get('sessionId') || undefined;
		const bot = await awaitBot();
		const data = await bot.getQR(sessionId);

		if ('alreadyConnected' in data && data.alreadyConnected) {
			return { qr: null, alreadyConnected: true, phoneNumber: data.phoneNumber || null };
		}

		if (data.qrCode) {
			const qrcodeModule = await import('qrcode');
			const qrDataUrl = await qrcodeModule.toDataURL(data.qrCode, {
				width: 300,
				margin: 2
			});
			return { qr: qrDataUrl, alreadyConnected: false };
		}

		return { qr: null, alreadyConnected: false };
	} catch (err) {
		logger.error({ err }, 'QR page load failed');
		return { qr: null, alreadyConnected: false };
	}
};
