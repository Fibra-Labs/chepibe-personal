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
        isGroup = false,
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
                if (isGroup) {
                    reply = senderPhoneNumber
                        ? `👥 Mensaje de grupo (de ${senderPhoneNumber}):\n\n⚠️ No se pudo transcribir el audio.`
                        : `👥 Mensaje de un grupo:\n\n⚠️ No se pudo transcribir el audio.`;
                } else if (isFromOtherChat && senderPhoneNumber) {
                    reply = `📱 Mensaje de ${senderPhoneNumber}:\n\n⚠️ No se pudo transcribir el audio.`;
                } else {
                    reply = '⚠️ No se pudo transcribir el audio.';
                }
            } else if (!result.summary?.trim()) {
                if (isGroup) {
                    reply = senderPhoneNumber
                        ? `👥 Mensaje de grupo (de ${senderPhoneNumber}):\n\n🎤 *Transcripción:*\n${result.transcription}`
                        : `👥 Mensaje de un grupo:\n\n🎤 *Transcripción:*\n${result.transcription}`;
                } else if (isFromOtherChat && senderPhoneNumber) {
                    reply = `📱 Mensaje de ${senderPhoneNumber}:\n\n🎤 *Transcripción:*\n${result.transcription}`;
                } else {
                    reply = `🎤 *Transcripción:*\n${result.transcription}`;
                }
            } else {
                if (isGroup) {
                    reply = senderPhoneNumber
                        ? `👥 Mensaje de grupo (de ${senderPhoneNumber}):\n\n🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`
                        : `👥 Mensaje de un grupo:\n\n🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`;
                } else if (isFromOtherChat && senderPhoneNumber) {
                    reply = `📱 Mensaje de ${senderPhoneNumber}:\n\n🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`;
                } else {
                    reply = `🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`;
                }
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
