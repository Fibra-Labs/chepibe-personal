import { getBot } from '$lib/server/bot';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const data = getBot().getStatus();
		return new Response(JSON.stringify(data), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch {
		return new Response(JSON.stringify({ connected: false, phoneNumber: null }), {
			headers: { 'Content-Type': 'application/json' }
		});
	}
};
