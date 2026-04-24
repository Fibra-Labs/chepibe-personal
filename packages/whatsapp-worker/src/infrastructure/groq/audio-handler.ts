import type {WASocket} from '@whiskeysockets/baileys';
import type {Logger} from 'pino';
import type {GroqClient} from './groq-client.js';

function stripDeviceSuffix(jid: string): string {
    return jid.replace(/:\d+@/, '@');
}

export class AudioHandler {
    constructor(
        private groqClient: GroqClient,
        private logger: Logger,
    ) {
    }

    async handleAudioMessage(
        socket: WASocket,
        senderJid: string,
        audioBuffer: Buffer,
        mimetype: string,
        messageId: string,
        duration?: number,
        senderPhoneNumber?: string,
        ownerJid?: string,
    ): Promise<void> {
        this.logger.info({messageId, duration, senderPhoneNumber}, 'Processing voice message');

        const cleanOwnerJid = ownerJid ? stripDeviceSuffix(ownerJid) : stripDeviceSuffix(senderJid);
        const cleanSenderJid = stripDeviceSuffix(senderJid);
        const isFromOtherChat = cleanSenderJid !== cleanOwnerJid;

        try {
            await socket.sendPresenceUpdate('composing', cleanOwnerJid);

            const result = await this.groqClient.processAudioMessage(audioBuffer, mimetype);

            let reply: string;

            if (!result.transcription?.trim()) {
                reply = isFromOtherChat && senderPhoneNumber
                    ? `📱 Mensaje de ${senderPhoneNumber}:\n\n⚠️ No se pudo transcribir el audio.`
                    : '⚠️ No se pudo transcribir el audio.';
            } else if (!result.summary?.trim()) {
                reply = isFromOtherChat && senderPhoneNumber
                    ? `📱 Mensaje de ${senderPhoneNumber}:\n\n🎤 *Transcripción:*\n${result.transcription}`
                    : `🎤 *Transcripción:*\n${result.transcription}`;
            } else {
                reply = isFromOtherChat && senderPhoneNumber
                    ? `📱 Mensaje de ${senderPhoneNumber}:\n\n🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`
                    : `🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`;
            }

            await socket.sendMessage(cleanOwnerJid, {text: reply});

            this.logger.info({
                messageId,
                duration,
                recipientJid: cleanOwnerJid,
                fromOther: isFromOtherChat
            }, 'Voice message processed and replied to owner');
        } catch (err) {
            this.logger.error({err, messageId}, 'Failed to process voice message');
        } finally {
            await socket.sendPresenceUpdate('paused', cleanOwnerJid);
        }
    }
}
