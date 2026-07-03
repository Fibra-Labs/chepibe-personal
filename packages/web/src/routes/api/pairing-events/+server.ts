import { awaitBot } from '$lib/server/bot';
import type { RequestHandler } from './$types';
import type { SessionEvent } from '@chepibe-personal/whatsapp-worker';

export const GET: RequestHandler = async () => {
	const bot = await awaitBot();

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function send(event: SessionEvent) {
				const step = getPairingStep(event);
				if (!step) return;
				const data = JSON.stringify({ step, ...extractPayload(event) });
				controller.enqueue(encoder.encode(`event: pairing-step\ndata: ${data}\n\n`));
			}

			function extractPayload(event: SessionEvent): Record<string, unknown> {
				switch (event.type) {
					case 'PASSKEY_REQUEST':
						return { sessionId: event.payload.sessionId, publicKey: event.payload.publicKey };
					case 'PASSKEY_CONFIRMATION':
						return { sessionId: event.payload.sessionId, code: event.payload.code, skipHandoffUX: event.payload.skipHandoffUX };
					case 'PASSKEY_ERROR':
						return { sessionId: event.payload.sessionId, error: event.payload.error, isContinuation: event.payload.isContinuation };
					default:
						return {};
				}
			}

			function getPairingStep(event: SessionEvent): string | null {
				switch (event.type) {
					case 'PASSKEY_REQUEST': return 'waiting_passkey';
					case 'PASSKEY_CONFIRMATION': return 'waiting_confirmation';
					case 'PASSKEY_ERROR': return 'error';
					case 'CONNECTED': return 'connected';
					default: return null;
				}
			}

			const off = bot.on('PASSKEY_REQUEST', (payload) => send({ type: 'PASSKEY_REQUEST', payload } as SessionEvent));
			const off2 = bot.on('PASSKEY_CONFIRMATION', (payload) => send({ type: 'PASSKEY_CONFIRMATION', payload } as SessionEvent));
			const off3 = bot.on('PASSKEY_ERROR', (payload) => send({ type: 'PASSKEY_ERROR', payload } as SessionEvent));
			const off4 = bot.on('CONNECTED', (payload) => {
				send({ type: 'CONNECTED', payload } as SessionEvent);
			});

			controller.enqueue(encoder.encode(`event: open\ndata: {}\n\n`));

			controller.close = new Proxy(controller.close, {
				apply(target, thisArg) {
					off();
					off2();
					off3();
					off4();
					return target.apply(thisArg);
				},
			});
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		},
	});
};
