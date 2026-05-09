import type { WASocket } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { GroqClient } from './groq-client.js';

function stripDeviceSuffix(jid: string): string {
  return jid.replace(/:\d+@/, '@');
}

export class AudioHandler {
  constructor(
    private groqClient: GroqClient,
    private logger: Logger,
  ) {}

  async handleAudioMessage(
    socket: WASocket,
    senderJid: string,
    audioBuffer: Buffer,
    mimetype: string,
    messageId: string,
    duration?: number,
    ownerPhoneNumber?: string,
    senderPhoneNumber?: string | null,
    pushName?: string | null,
    isGroup = false,
    groupName?: string | null,
  ): Promise<void> {
    this.logger.info({ messageId, duration, senderJid, ownerPhoneNumber, senderPhoneNumber, pushName, isGroup, groupName }, 'Processing voice message');

    const ownerJidToUse = `${ownerPhoneNumber}@s.whatsapp.net`;
    const cleanSenderJid = stripDeviceSuffix(senderJid);
    const isFromSelf = senderPhoneNumber === ownerPhoneNumber;

    try {
      const result = await this.groqClient.processAudioMessage(audioBuffer, mimetype);

      let reply: string;
      const senderLabel = senderPhoneNumber || pushName || cleanSenderJid;

      // Build prefix for group messages
      const prefix = isGroup && groupName
        ? `👥 *${groupName}* - ${senderLabel}:\n\n`
        : isGroup
          ? `👥 Grupo - ${senderLabel}:\n\n`
          : isFromSelf
            ? ''
            : `📱 Audio de ${senderLabel}:\n\n`;

      if (!result.transcription?.trim()) {
        reply = isFromSelf && !isGroup
          ? '⚠️ No se pudo transcribir el audio.'
          : `${prefix}⚠️ No se pudo transcribir el audio.`;
      } else if (!result.summary?.trim()) {
        reply = isFromSelf && !isGroup
          ? `🎤 *Transcripción:*\n${result.transcription}`
          : `${prefix}🎤 *Transcripción:*\n${result.transcription}`;
      } else {
        reply = isFromSelf && !isGroup
          ? `🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`
          : `${prefix}🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`;
      }

      await socket.sendMessage(ownerJidToUse, { text: reply });

      this.logger.info({
        messageId,
        duration,
        recipientJid: ownerJidToUse,
        senderJid: cleanSenderJid,
        isGroup,
        groupName,
      }, 'Voice message processed and sent to owner');
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to process voice message');
      throw new Error('Failed to process audio', { cause: err });
    }
  }
}
