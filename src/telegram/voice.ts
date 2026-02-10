// Voice pipeline: STT (multi-provider), prompt optimization (AI provider), TTS (multi-provider)

import { Readable } from 'stream';
import { AIProvider, SessionContext } from './ai-provider.js';
import { STTTTSProvider } from './stt-tts-provider.js';

export interface VoicePipelineOptions {
  sttProvider: STTTTSProvider;
  aiProvider: AIProvider;
  language?: string; // ISO-639-1, default 'en'
}

export class VoicePipeline {
  private sttProvider: STTTTSProvider;
  private aiProvider: AIProvider;
  private language: string;

  constructor(options: VoicePipelineOptions) {
    this.sttProvider = options.sttProvider;
    this.aiProvider = options.aiProvider;
    this.language = options.language || 'en';
  }

  /**
   * Transcribe audio from a readable stream (e.g., Telegram voice OGG).
   */
  async transcribe(audioStream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);
    return this.sttProvider.transcribe(audioBuffer, this.language);
  }

  /**
   * Optimize a voice transcript into an actionable prompt using the AI provider.
   */
  async optimizePrompt(transcript: string, context?: SessionContext): Promise<string> {
    return this.aiProvider.optimizePrompt(transcript, context);
  }

  /**
   * Synthesize text to speech. Returns an OGG Opus buffer for Telegram.
   */
  async synthesize(text: string): Promise<Buffer> {
    return this.sttProvider.synthesize(text);
  }

  /**
   * Check if TTS is available.
   */
  async isTTSAvailable(): Promise<boolean> {
    return this.sttProvider.isTTSAvailable();
  }

  getInfo(): { stt: string; ai: { provider: string; model: string }; language: string } {
    return {
      stt: this.sttProvider.getInfo().provider,
      ai: this.aiProvider.getInfo(),
      language: this.language,
    };
  }
}
