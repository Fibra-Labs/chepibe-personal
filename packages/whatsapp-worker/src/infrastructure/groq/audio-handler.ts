import type {WASocket} from '@whiskeysockets/baileys';
import type {Logger} from 'pino';
import {AudioProcessingError} from '../../domain/audio-processing-error.js';
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
        ownerPhoneNumber?: string,
        senderPhoneNumber?: string | null,
        pushName?: string | null,
        isGroup = false,
    ): Promise<void> {
        this.logger.info({messageId, duration, senderJid, ownerPhoneNumber, senderPhoneNumber, pushName}, 'Processing voice message');

        // ALWAYS send the transcription to the owner's phone number
        const ownerJidToUse = `${ownerPhoneNumber}@s.whatsapp.net`;
        const cleanSenderJid = stripDeviceSuffix(senderJid);

        // Only consider it "from self" if the resolved phone matches the owner
        // LIDs and null phone numbers will show sender info
        const isFromSelf = senderPhoneNumber === ownerPhoneNumber;

        try {
            const result = await this.groqClient.processAudioMessage(audioBuffer, mimetype);

            let reply: string;

            // Show sender info: prefer phone number, then pushName (display name), then JID/LID
            const senderLabel = senderPhoneNumber || pushName || cleanSenderJid;

            if (!result.transcription?.trim()) {
                reply = isFromSelf
                    ? '⚠️ No se pudo transcribir el audio.'
                    : `📱 Audio de ${senderLabel}:\n\n⚠️ No se pudo transcribir el audio.`;
            } else if (!result.summary?.trim()) {
                reply = isFromSelf
                    ? `🎤 *Transcripción:*\n${result.transcription}`
                    : `📱 Audio de ${senderLabel}:\n\n🎤 *Transcripción:*\n${result.transcription}`;
            } else {
                reply = isFromSelf
                    ? `🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`
                    : `📱 Audio de ${senderLabel}:\n\n🎤 *Transcripción:*\n${result.transcription}\n\n📝 *Resumen:*\n${result.summary}`;
            }

            // ALWAYS send to owner's phone number
            await socket.sendMessage(ownerJidToUse, {text: reply});

            this.logger.info({
                messageId,
                duration,
                recipientJid: ownerJidToUse,
                senderJid: cleanSenderJid
            }, 'Voice message processed and sent to owner');
        } catch (err) {
            this.logger.error({err, messageId}, 'Failed to process voice message');
            throw new AudioProcessingError('Failed to process audio', { cause: err });
        }
    }
}
