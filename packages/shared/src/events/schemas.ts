import { z } from "zod";
import { WhatsAppEvent, WhatsAppCommand } from "./index";

export const QrReadyPayloadSchema = z.object({
  sessionId: z.string(),
  qrCode: z.string(),
});

export const ConnectedPayloadSchema = z.object({
  sessionId: z.string(),
  phoneNumber: z.string(),
});

export const DisconnectedPayloadSchema = z.object({
  sessionId: z.string(),
  reason: z.string().optional(),
});

export const LoggedOutPayloadSchema = z.object({
  sessionId: z.string(),
});

export const VoiceMessageReceivedPayloadSchema = z.object({
  sessionId: z.string(),
  phoneNumber: z.string(),
  messageId: z.string(),
  audioBuffer: z.string(),
  mimetype: z.string(),
  duration: z.number(),
});

export const MessageReceivedPayloadSchema = z.object({
  sessionId: z.string(),
  phoneNumber: z.string(),
  messageId: z.string(),
  text: z.string(),
});

export const OwnerMessageSentPayloadSchema = z.object({
  sessionId: z.string(),
  phoneNumber: z.string(),
  messageId: z.string(),
  text: z.string(),
});

export const ConnectSessionPayloadSchema = z.object({
  sessionId: z.string(),
});

export const DisconnectSessionPayloadSchema = z.object({
  sessionId: z.string(),
});

export const SendMessagePayloadSchema = z.object({
  sessionId: z.string(),
  phoneNumber: z.string(),
  text: z.string(),
});

export const SendAudioMessagePayloadSchema = z.object({
  sessionId: z.string(),
  phoneNumber: z.string(),
  audioBuffer: z.string(),
  mimetype: z.string(),
});

export const WhatsAppEventSchema = z.nativeEnum(WhatsAppEvent);
export const WhatsAppCommandSchema = z.nativeEnum(WhatsAppCommand);