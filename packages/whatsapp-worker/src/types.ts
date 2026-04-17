import type { WASocket } from '@whiskeysockets/baileys';

export enum SessionStatus {
  PENDING = 'pending',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  EXPIRED = 'expired',
}

export interface BaileysSession {
  sessionId: string;
  socket: WASocket;
  status: SessionStatus;
  qrCode?: string;
  phoneNumber?: string;
  createdAt: Date;
}

export interface TranscriptionResult {
  transcription: string;
  summary: string;
}