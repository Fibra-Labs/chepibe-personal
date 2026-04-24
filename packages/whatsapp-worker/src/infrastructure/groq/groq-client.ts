import Groq from 'groq-sdk';
import type { Logger } from 'pino';
import type { TranscriptionResult } from '../../types/transcription-result.js';

function getExtensionFromMimetype(mimetype: string): string {
  switch (mimetype) {
    case 'audio/mpeg': return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a': return 'm4a';
    case 'audio/wav': return 'wav';
    case 'audio/webm': return 'webm';
    case 'audio/ogg':
    default: return 'ogg';
  }
}

function getMimeTypeFromExtension(ext: string): string {
  switch (ext) {
    case 'mp3': return 'audio/mpeg';
    case 'mp4': return 'audio/mp4';
    case 'm4a': return 'audio/m4a';
    case 'wav': return 'audio/wav';
    case 'webm': return 'audio/webm';
    case 'ogg':
    default: return 'audio/ogg';
  }
}

export class GroqClient {
  private groq: Groq;
  private whisperModel: string;
  private llmModel: string;

  constructor(apiKey: string, whisperModel: string, llmModel: string, private logger: Logger) {
    this.groq = new Groq({ apiKey });
    this.whisperModel = whisperModel;
    this.llmModel = llmModel;
  }

  private withoutGroqDebug<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.DEBUG;
    delete process.env.DEBUG;
    return fn().finally(() => {
      if (saved !== undefined) process.env.DEBUG = saved;
    });
  }

  async transcribeAudio(audioBuffer: Buffer, mimetype: string): Promise<string> {
    const ext = getExtensionFromMimetype(mimetype || 'audio/ogg');
    const fileMimetype = getMimeTypeFromExtension(ext);
    const filename = `voice.${ext}`;
    const fileSize = audioBuffer.length;

    this.logger.info({ filename, fileMimetype, fileSize, model: this.whisperModel }, 'Sending audio to Groq Whisper');

    try {
      const file = new File([new Uint8Array(audioBuffer)], filename, { type: fileMimetype });

      const response = await this.withoutGroqDebug(() => this.groq.audio.transcriptions.create({
        model: this.whisperModel,
        file,
        response_format: 'text',
        language: 'es',
      }));

      const transcription = typeof response === 'string' ? response : response.text;
      this.logger.info({ filename, transcriptionLength: transcription?.length ?? 0 }, 'Whisper transcription complete');
      return transcription;
    } catch (err: any) {
      this.logger.error({
        err,
        errorMessage: err?.message,
        errorStatus: err?.status,
        errorCode: err?.error?.code,
        errorType: err?.error?.type,
        filename,
        fileMimetype,
        fileSize,
        model: this.whisperModel,
      }, 'Groq Whisper transcription failed');
      throw err;
    }
  }

  async summarizeTranscription(transcription: string): Promise<string> {
    const transcriptionLength = transcription?.length ?? 0;

    if (!transcription?.trim()) {
      this.logger.warn({ transcriptionLength, model: this.llmModel }, 'Skipping summarization: transcription is empty');
      return '';
    }

    this.logger.info({ transcriptionLength, model: this.llmModel }, 'Summarizing transcription');

    try {
      const response = await this.withoutGroqDebug(() => this.groq.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content: 'Sos un asistente que genera resúmenes breves. La transcripción que vas a recibir es la textual de un audio. Tu ÚNICA tarea es generar un resumen de 2-3 oraciones máximo, capturando la idea principal. NO repitas la transcripción. NO respondas al contenido. Solo resumí. Ejemplo: si la transcripción dice "mañana tengo que ir al banco a pagar la factura de luz y después paso por el super", el resumen debe ser "Tiene que pagar la factura de luz e ir al supermercado".',
          },
          {
            role: 'user',
            content: transcription,
          },
        ],
        temperature: 0.3,
        max_completion_tokens: 256,
      }));

      const summary = response.choices[0]?.message?.content ?? '';
      this.logger.info({ summaryLength: summary.length, model: this.llmModel }, 'Summarization complete');
      return summary;
    } catch (err: any) {
      this.logger.error({
        err,
        errorMessage: err?.message,
        errorStatus: err?.status,
        errorCode: err?.error?.code,
        errorType: err?.error?.type,
        transcriptionLength,
        model: this.llmModel,
      }, 'Groq LLM summarization failed');
      return '';
    }
  }

  async processAudioMessage(audioBuffer: Buffer, mimetype: string): Promise<TranscriptionResult> {
    const transcription = await this.transcribeAudio(audioBuffer, mimetype);
    const summary = await this.summarizeTranscription(transcription);
    return { transcription, summary };
  }
}
