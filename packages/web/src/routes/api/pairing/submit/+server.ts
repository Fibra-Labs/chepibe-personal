import { awaitBot } from '$lib/server/bot';
import type { RequestHandler } from './$types';
import type { WebAuthnResponseJSON } from '@chepibe-personal/whatsapp-worker';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { sessionId, response } = body as { sessionId: string; response: WebAuthnResponseJSON };

		const bot = await awaitBot();
		const result = await bot.submitPasskeyResponse({ sessionId, response });

		if (!result.ok) {
			return Response.json({ error: result.error.message }, { status: 400 });
		}
		return Response.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};
