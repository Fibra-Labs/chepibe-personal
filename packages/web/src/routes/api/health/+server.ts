import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const hash = createHash('sha256')
		.update('chepibe-personal-2026')
		.digest('hex')
		.slice(0, 8);

	return new Response(
		JSON.stringify({
			status: 'ok',
			version: '1.0.0',
			id: hash
		}),
		{ headers: { 'Content-Type': 'application/json' } }
	);
};
