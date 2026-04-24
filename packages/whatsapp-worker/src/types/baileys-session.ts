import type { WASocket } from '@whiskeysockets/baileys';
import type { SessionStatus } from './session-status.js';

export interface BaileysSession {
	sessionId: string;
	socket: WASocket;
	status: SessionStatus;
	qrCode?: string;
	phoneNumber?: string;
	createdAt: Date;
}
