import { config } from '$lib/server/config';
import type { Actions } from '@sveltejs/kit';

export const load = async () => {
	try {
		const response = await fetch(`${config.workerApiUrl}/api/status`);
		const data = await response.json();
		return {
			connected: data.connected ?? false,
			phoneNumber: data.phoneNumber ?? null,
			sessionId: data.sessions?.[0]?.sessionId ?? null,
			allowedPhone: config.allowedPhone
		};
	} catch {
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
			await fetch(`${config.workerApiUrl}/api/disconnect`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId })
			});
		} catch {}
		return { success: true };
	}
};