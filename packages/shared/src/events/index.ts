export enum WhatsAppEvent {
  QR_READY = "QR_READY",
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
  RECOVERABLE_DISCONNECT = "RECOVERABLE_DISCONNECT",
  PERMANENT_DISCONNECT = "PERMANENT_DISCONNECT",
  LOGGED_OUT = "LOGGED_OUT",
  VOICE_MESSAGE_RECEIVED = "VOICE_MESSAGE_RECEIVED",
  MESSAGE_RECEIVED = "MESSAGE_RECEIVED",
  OWNER_MESSAGE_SENT = "OWNER_MESSAGE_SENT",
}

export enum WhatsAppCommand {
  CONNECT_SESSION = "CONNECT_SESSION",
  DISCONNECT_SESSION = "DISCONNECT_SESSION",
  SEND_MESSAGE = "SEND_MESSAGE",
  SEND_AUDIO_MESSAGE = "SEND_AUDIO_MESSAGE",
}

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
  reason?: string;
}

export interface LoggedOutPayload {
  sessionId: string;
}

export interface VoiceMessageReceivedPayload {
  sessionId: string;
  phoneNumber: string;
  messageId: string;
  audioBuffer: string;
  mimetype: string;
  duration: number;
}

export interface MessageReceivedPayload {
  sessionId: string;
  phoneNumber: string;
  messageId: string;
  text: string;
}

export interface OwnerMessageSentPayload {
  sessionId: string;
  phoneNumber: string;
  messageId: string;
  text: string;
}

export interface ConnectSessionPayload {
  sessionId: string;
}

export interface DisconnectSessionPayload {
  sessionId: string;
}

export interface SendMessagePayload {
  sessionId: string;
  phoneNumber: string;
  text: string;
}

export interface SendAudioMessagePayload {
  sessionId: string;
  phoneNumber: string;
  audioBuffer: string;
  mimetype: string;
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

export type WhatsAppEventPayloadMap = {
  [WhatsAppEvent.QR_READY]: QrReadyPayload;
  [WhatsAppEvent.CONNECTED]: ConnectedPayload;
  [WhatsAppEvent.DISCONNECTED]: DisconnectedPayload;
  [WhatsAppEvent.RECOVERABLE_DISCONNECT]: RecoverableDisconnectPayload;
  [WhatsAppEvent.PERMANENT_DISCONNECT]: PermanentDisconnectPayload;
  [WhatsAppEvent.LOGGED_OUT]: LoggedOutPayload;
  [WhatsAppEvent.VOICE_MESSAGE_RECEIVED]: VoiceMessageReceivedPayload;
  [WhatsAppEvent.MESSAGE_RECEIVED]: MessageReceivedPayload;
  [WhatsAppEvent.OWNER_MESSAGE_SENT]: OwnerMessageSentPayload;
};

export type WhatsAppCommandPayloadMap = {
  [WhatsAppCommand.CONNECT_SESSION]: ConnectSessionPayload;
  [WhatsAppCommand.DISCONNECT_SESSION]: DisconnectSessionPayload;
  [WhatsAppCommand.SEND_MESSAGE]: SendMessagePayload;
  [WhatsAppCommand.SEND_AUDIO_MESSAGE]: SendAudioMessagePayload;
};