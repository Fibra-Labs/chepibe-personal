export enum SessionState {
  None = 'none',
  Pending = 'pending',
  Connected = 'connected',
  Destroyed = 'destroyed',
  Reconnecting = 'reconnecting',
}

export enum BaileysEvent {
  ConnectionUpdate = 'connection.update',
  MessagesUpsert = 'messages.upsert',
  CredsUpdate = 'creds.update',
}

export enum BaileysConnection {
  Open = 'open',
  Close = 'close',
}

export enum SessionAction {
  StartQr = 'startQR',
  StartPairing = 'startPairing',
  ConnectionOpen = 'connection.open',
}

export const DB_SESSION_STATUS_PENDING = 'pending' as const;
export const DB_SESSION_STATUS_CONNECTED = 'connected' as const;
export const DB_SESSION_STATUS_DISCONNECTED = 'disconnected' as const;

export const WHATSAPP_JID_SUFFIX = '@s.whatsapp.net' as const;
export const LID_SUFFIX = '@lid' as const;

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