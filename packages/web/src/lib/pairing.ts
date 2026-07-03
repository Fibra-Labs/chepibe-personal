export interface PairingState {
	step: 'idle' | 'waiting_passkey' | 'waiting_confirmation' | 'connected' | 'error';
	sessionId?: string;
	publicKey?: string;
	code?: string;
	error?: string;
}

export function createPairingSSE(onState: (state: PairingState) => void): () => void {
	let es: EventSource | null = null;
	let retries = 0;
	const maxRetries = 3;

	function connect() {
		es = new EventSource('/api/pairing-events');

		es.addEventListener('pairing-step', (e) => {
			retries = 0;
			const data = JSON.parse(e.data);
			onState({
				step: data.step,
				sessionId: data.sessionId,
				publicKey: data.publicKey,
				code: data.code,
				error: data.error,
			});
		});

		es.addEventListener('connected', () => {
			retries = 0;
			onState({ step: 'connected' });
		});

		es.onerror = () => {
			es?.close();
			if (retries < maxRetries) {
				retries++;
				const delay = Math.min(1000 * Math.pow(2, retries), 10000);
				setTimeout(connect, delay);
			}
		};
	}

	connect();

	return () => {
		es?.close();
		es = null;
	};
}
