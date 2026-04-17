import { config } from '$lib/server/config';
import type { ServerLoad } from '@sveltejs/kit';

export const load: ServerLoad = async () => {
	try {
		const response = await fetch(`${config.workerApiUrl}/api/qr`);
		const data = await response.json();

		if (data.alreadyConnected) {
			return { qr: null, alreadyConnected: true, phoneNumber: data.phoneNumber };
		}

		if (data.qrCode) {
			const QRCode = await import('qrcode');
			const qrDataUrl = await QRCode.toDataURL(data.qrCode, {
				width: 300,
				margin: 2
			});
			return { qr: qrDataUrl, alreadyConnected: false };
		}

		return { qr: null, alreadyConnected: false };
	} catch {
		return { qr: null, alreadyConnected: false };
	}
};
