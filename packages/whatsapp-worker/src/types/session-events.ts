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