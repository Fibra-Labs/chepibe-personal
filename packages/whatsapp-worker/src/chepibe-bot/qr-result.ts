export type QRResult =
	| { qrCode: string; sessionId: string; alreadyConnected: false }
	| { alreadyConnected: true; sessionId?: string; phoneNumber?: string; qrCode?: string };
