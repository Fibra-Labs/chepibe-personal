import { awaitBot } from '$lib/server/bot';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { sessionId } = body as { sessionId: string };

		const bot = await awaitBot();
		const result = await bot.submitPasskeyConfirmation();

		if (!result.ok) {
			return Response.json({ error: result.error.message }, { status: 400 });
		}
		return Response.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};
