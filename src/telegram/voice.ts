// Voice pipeline: STT (Speechmatics), prompt optimization (AI provider), TTS (Speechmatics)

import { BatchClient } from '@speechmatics/batch-client';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { Readable } from 'stream';
import { AIProvider, SessionContext } from './ai-provider.js';

export interface VoicePipelineOptions {
  speechmaticsApiKey: string;
  aiProvider: AIProvider;
  tempDir: string;
  language?: string; // ISO-639-1, default 'en'
}

export class VoicePipeline {
  private batchClient: BatchClient;
  private aiProvider: AIProvider;
  private tempDir: string;
  private language: string;

  constructor(options: VoicePipelineOptions) {
    this.batchClient = new BatchClient({
      apiKey: options.speechmaticsApiKey,
      appId: 'claude-b',
    });
    this.aiProvider = options.aiProvider;
    this.tempDir = options.tempDir;
    this.language = options.language || 'en';
  }

  /**
   * Transcribe audio from a readable stream (e.g., Telegram voice OGG).
   * Returns the transcript text.
   */
  async transcribe(audioStream: Readable): Promise<string> {
    await mkdir(this.tempDir, { recursive: true });

    // Write stream to temp file (Speechmatics batch API needs a file/blob)
    const tempFile = join(this.tempDir, `voice-${randomBytes(8).toString('hex')}.ogg`);
    const chunks: Buffer[] = [];

    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);
    await writeFile(tempFile, audioBuffer);

    try {
      // Use the high-level transcribe method which handles submit + poll
      const result = await this.batchClient.transcribe(
        { data: new Blob([audioBuffer]), fileName: 'voice.ogg' },
        {
          transcription_config: {
            language: this.language,
            operating_point: 'enhanced',
          },
        },
        'text',
        120000 // 2 minute timeout
      );

      // 'text' format returns a string
      if (typeof result === 'string') {
        return result.trim();
      }

      // json-v2 format: extract text from results
      const words = result.results
        .filter(r => r.alternatives && r.alternatives.length > 0)
        .map(r => r.alternatives![0].content)
        .join('');

      return words.trim();
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Optimize a voice transcript into an actionable prompt using the AI provider.
   */
  async optimizePrompt(transcript: string, context?: SessionContext): Promise<string> {
    return this.aiProvider.optimizePrompt(transcript, context);
  }

  /**
   * Synthesize text to speech using Speechmatics TTS API.
   * Returns an OGG Opus buffer suitable for Telegram sendVoice().
   */
  async synthesize(text: string): Promise<Buffer> {
    // Speechmatics TTS API — direct HTTP (no SDK yet)
    const response = await fetch('https://mp.speechmatics.com/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.batchClient.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 5000), // TTS has char limits
        model: 'speechmatics',
        output_format: {
          type: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 16000,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Speechmatics TTS failed (${response.status}): ${errText}`);
    }

    const rawAudio = Buffer.from(await response.arrayBuffer());

    // Convert raw PCM to OGG Opus for Telegram
    return this.convertToOggOpus(rawAudio);
  }

  /**
   * Convert raw PCM audio to OGG Opus using ffmpeg.
   * Falls back to throwing if ffmpeg is not available.
   */
  private async convertToOggOpus(pcmBuffer: Buffer): Promise<Buffer> {
    await mkdir(this.tempDir, { recursive: true });
    const id = randomBytes(8).toString('hex');
    const inputFile = join(this.tempDir, `tts-${id}.raw`);
    const outputFile = join(this.tempDir, `tts-${id}.ogg`);

    await writeFile(inputFile, pcmBuffer);

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('ffmpeg', [
          '-f', 's16le',
          '-ar', '16000',
          '-ac', '1',
          '-i', inputFile,
          '-c:a', 'libopus',
          '-b:a', '64k',
          '-f', 'ogg',
          outputFile,
        ], { timeout: 30000 }, (error) => {
          if (error) reject(new Error(`ffmpeg conversion failed: ${error.message}`));
          else resolve();
        });
      });

      const { readFile } = await import('fs/promises');
      return await readFile(outputFile);
    } finally {
      await unlink(inputFile).catch(() => {});
      await unlink(outputFile).catch(() => {});
    }
  }

  /**
   * Check if TTS is available (ffmpeg installed).
   */
  async isTTSAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('ffmpeg', ['-version'], { timeout: 5000 }, (error) => {
        resolve(!error);
      });
    });
  }

  getInfo(): { stt: string; ai: { provider: string; model: string }; language: string } {
    return {
      stt: 'Speechmatics',
      ai: this.aiProvider.getInfo(),
      language: this.language,
    };
  }
}
