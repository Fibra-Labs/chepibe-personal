import { awaitBot } from '$lib/server/bot';
import { env } from '$env/dynamic/private';
import pino from 'pino';
import type { Actions, ServerLoad } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';

const logger = pino({
	level: env.DEBUG === 'true' ? 'debug' : 'error',
	transport: env.DEBUG === 'true'
		? { target: 'pino-pretty', options: { colorize: true } }
		: undefined,
});

export const load: ServerLoad = async ({ url }) => {
	try {
		const bot = await awaitBot();
		const status = bot.getStatus();

		if (status.connected) {
			logger.info('Redirecting from /qr to / because session is already connected');
			throw redirect(303, '/');
		}

		const mode = url.searchParams.get('mode');
		if (mode === 'pairing') {
			return { qr: null, alreadyConnected: false, mode: 'pairing' as const };
		}

		const data = await bot.getQR();

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
		if (err instanceof Response && err.status === 303) {
			throw err;
		}
		logger.error({ err }, 'QR page load failed');
		return { qr: null, alreadyConnected: false };
	}
};

export const actions = {
	default: async () => {
		const phoneNumber = env.ALLOWED_PHONE;

		if (!phoneNumber) {
			return { pairingError: 'ALLOWED_PHONE no está configurado' };
		}

		try {
			const bot = await awaitBot();

			// Check if already connected before attempting pairing
			const status = bot.getStatus();
			if (status.connected) {
				logger.warn('Attempted to request pairing code while connected');
				throw redirect(303, '/');
			}

			const result = await bot.requestPairingCode(phoneNumber);

			return { pairingCode: result.code };
		} catch (err: any) {
			if (err instanceof Response && err.status === 303) {
				throw err;
			}
			logger.error({ err }, 'Pairing code request failed');
			return { pairingError: err?.message || 'No se pudo generar el código de emparejamiento' };
		}
	},
} satisfies Actions;