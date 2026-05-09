// --- Result type ---

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// --- Transcription ---

export interface TranscriptionResult {
  transcription: string;
  summary: string;
}

// --- Session status ---

export type SessionStatus = 'none' | 'pending' | 'connected' | 'reconnecting' | 'destroyed';

// --- Session events ---

export interface QrReadyPayload {
  sessionId: string;
  qrCode: string;
}

export interface ConnectedPayload {
  sessionId: string;
  phoneNumber: string;
}

export interface DisconnectedPayload {
  sessionId: string;
  reason: string;
}

export interface RecoverableDisconnectPayload {
  sessionId: string;
  reason: string;
  statusCode: number;
}

export interface PermanentDisconnectPayload {
  sessionId: string;
  reason: string;
  statusCode: number;
}

export type SessionEvent =
  | { type: 'QR_READY'; payload: QrReadyPayload }
  | { type: 'CONNECTED'; payload: ConnectedPayload }
  | { type: 'DISCONNECTED'; payload: DisconnectedPayload }
  | { type: 'RECOVERABLE_DISCONNECT'; payload: RecoverableDisconnectPayload }
  | { type: 'PERMANENT_DISCONNECT'; payload: PermanentDisconnectPayload };

export const SessionEventName = {
  QrReady: 'QR_READY',
  Connected: 'CONNECTED',
  Disconnected: 'DISCONNECTED',
  RecoverableDisconnect: 'RECOVERABLE_DISCONNECT',
  PermanentDisconnect: 'PERMANENT_DISCONNECT',
} as const;

export type SessionEventName = (typeof SessionEventName)[keyof typeof SessionEventName];

// --- Disconnect codes ---

export enum BaileysDisconnectCode {
  LoggedOut = 401,
  MethodNotAllowed = 405,
  RestartRequired = 515,
  Conflict = 440,
}

export enum TeardownReason {
  PhoneMismatch = 'phone_mismatch',
  QrTimeout = 'qr_timeout',
  PairingRequest = 'pairing_request',
  PairingTimeout = 'pairing_timeout',
  PairingCodeFailed = 'pairing_code_failed',
  LoggedOut = 'logged_out',
  ConnectionClosed = 'connection_closed',
  InvalidSession = 'invalid_session',
  MaxRetries = 'max_retries',
  Disconnected = 'disconnected',
  Shutdown = 'shutdown',
}

// --- Constants ---

export const SESSION_ID_PREFIX = 'session_';

export const BaileysEvent = {
  ConnectionUpdate: 'connection.update',
  MessagesUpsert: 'messages.upsert',
  CredsUpdate: 'creds.update',
} as const;

export const BaileysConnection = {
  Open: 'open',
  Close: 'close',
} as const;

export const SessionAction = {
  StartQr: 'startQR',
  StartPairing: 'startPairing',
  ConnectionOpen: 'connection.open',
} as const;

export const DB_SESSION_STATUS_PENDING = 'pending' as const;
export const DB_SESSION_STATUS_CONNECTED = 'connected' as const;
export const DB_SESSION_STATUS_DISCONNECTED = 'disconnected' as const;

export const WHATSAPP_JID_SUFFIX = '@s.whatsapp.net' as const;
export const LID_SUFFIX = '@lid' as const;
export const GROUP_JID_SUFFIX = '@g.us' as const;

export const DEDUP_TTL_SECONDS = 86400;
export const RESPONSIVE_THRESHOLD_MS = 60000;

export const MAX_RECONNECT_ATTEMPTS = 10;
export const RECONNECT_BASE_DELAY_MS = 2000;
export const RECONNECT_MAX_DELAY_MS = 60000;
export const QR_TIMEOUT_MS = 60000;
export const PAIRING_TIMEOUT_MS = 60000;

export const ERROR_PREFIX_TIMEOUT_QR = 'Timeout waiting for QR code';
export const ERROR_PREFIX_TIMEOUT_PAIRING = 'Timeout waiting for pairing code';
export const ERROR_PAIRING_CODE_FAILED = 'Failed to request pairing code';
export const ERROR_PHONE_MISMATCH = 'Phone number mismatch';
export const ERROR_NO_SOCKET = 'No socket';
export const ERROR_SEND_FAILED = 'Send failed';
export const ERROR_RECONNECT_FAILED = 'Reconnect failed';

// --- QR Result ---

export type QRResult =
  | { qrCode: string; sessionId: string; alreadyConnected: false }
  | { alreadyConnected: true; sessionId?: string; phoneNumber?: string; qrCode?: string };

// --- Bot options ---

import type { Logger } from 'pino';

export interface BotOptions {
  groqApiKey: string;
  groqWhisperModel: string;
  groqLlmModel: string;
  allowedPhone: string;
  databaseUrl: string;
  databasePassword?: string;
  logger?: Logger;
  migrationsPath?: string;
}
