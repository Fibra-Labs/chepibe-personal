import { config } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const response = await fetch(`${config.workerApiUrl}/api/status`);
		const data = await response.json();
		return new Response(JSON.stringify(data), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch {
		return new Response(JSON.stringify({ connected: false, phoneNumber: null }), {
			headers: { 'Content-Type': 'application/json' }
		});
	}
};