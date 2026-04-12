// STT/TTS provider abstraction — supports Speechmatics, Deepgram, OpenAI

import { BatchClient } from '@speechmatics/batch-client';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';

export interface STTProviderConfig {
  provider: 'speechmatics' | 'deepgram' | 'openai';
  apiKey: string;
  ttsModel?: string;
  ttsVoice?: string;
}

export interface STTTTSProvider {
  transcribe(audioBuffer: Buffer, language?: string): Promise<string>;
  synthesize(text: string): Promise<Buffer>;
  isTTSAvailable(): Promise<boolean>;
  getInfo(): { provider: string };
}

export function createSTTTTSProvider(config: STTProviderConfig, tempDir: string): STTTTSProvider {
  switch (config.provider) {
    case 'speechmatics':
      return new SpeechmaticsProvider(config.apiKey, tempDir);
    case 'deepgram':
      return new DeepgramProvider(config.apiKey);
    case 'openai':
      return new OpenAIProvider(config.apiKey, tempDir, config.ttsModel, config.ttsVoice);
    default:
      throw new Error(`Unknown STT provider: ${config.provider}`);
  }
}

// ─── Speechmatics ───────────────────────────────────────────────────────────

class SpeechmaticsProvider implements STTTTSProvider {
  private batchClient: BatchClient;
  private apiKey: string;
  private tempDir: string;

  constructor(apiKey: string, tempDir: string) {
    this.apiKey = apiKey;
    this.tempDir = tempDir;
    this.batchClient = new BatchClient({ apiKey, appId: 'claude-b' });
  }

  async transcribe(audioBuffer: Buffer, language = 'en'): Promise<string> {
    const result = await this.batchClient.transcribe(
      { data: new Blob([audioBuffer]), fileName: 'voice.ogg' },
      { transcription_config: { language, operating_point: 'enhanced' } },
      'text',
      120000,
    );

    if (typeof result === 'string') return result.trim();

    return result.results
      .filter((r: { alternatives?: { content: string }[] }) => r.alternatives && r.alternatives.length > 0)
      .map((r: { alternatives?: { content: string }[] }) => r.alternatives![0].content)
      .join('')
      .trim();
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch('https://mp.speechmatics.com/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        model: 'speechmatics',
        output_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Speechmatics TTS failed (${response.status}): ${errText}`);
    }

    const rawAudio = Buffer.from(await response.arrayBuffer());
    return convertPcmToOggOpus(rawAudio, this.tempDir);
  }

  async isTTSAvailable(): Promise<boolean> {
    return checkFfmpeg();
  }

  getInfo() { return { provider: 'Speechmatics' }; }
}

// ─── Deepgram ───────────────────────────────────────────────────────────────

class DeepgramProvider implements STTTTSProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audioBuffer: Buffer, language = 'en'): Promise<string> {
    const url = `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}&smart_format=true`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'audio/ogg',
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Deepgram STT failed (${response.status}): ${errText}`);
    }

    const data = await response.json() as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
  }

  async synthesize(text: string): Promise<Buffer> {
    // Deepgram Aura TTS — request OGG Opus directly (no ffmpeg needed)
    const url = 'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=opus&container=ogg';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: text.slice(0, 5000) }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Deepgram TTS failed (${response.status}): ${errText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async isTTSAvailable(): Promise<boolean> {
    return true; // No ffmpeg needed — Deepgram outputs OGG Opus directly
  }

  getInfo() { return { provider: 'Deepgram' }; }
}

// ─── OpenAI (Whisper STT + TTS) ────────────────────────────────────────────

class OpenAIProvider implements STTTTSProvider {
  private apiKey: string;
  private tempDir: string;
  private ttsModel: string;
  private ttsVoice: string;

  constructor(apiKey: string, tempDir: string, ttsModel?: string, ttsVoice?: string) {
    this.apiKey = apiKey;
    this.tempDir = tempDir;
    this.ttsModel = ttsModel || 'gpt-4o-mini-tts';
    this.ttsVoice = ttsVoice || 'alloy';
  }

  async transcribe(audioBuffer: Buffer, language = 'en'): Promise<string> {
    // OpenAI Whisper requires multipart form upload
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, 'voice.ogg');
    form.append('model', 'whisper-1');
    form.append('language', language);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI Whisper STT failed (${response.status}): ${errText}`);
    }

    const data = await response.json() as { text?: string };
    return data.text?.trim() || '';
  }

  async synthesize(text: string): Promise<Buffer> {
    // Model and voice come from STTProviderConfig (telegram.json). Defaults
    // were set in the constructor. Edit telegram.json → restart daemon to
    // switch model/voice without code changes.
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.ttsModel,
        input: text.slice(0, 4096), // OpenAI TTS input limit
        voice: this.ttsVoice,
        response_format: 'opus',
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI TTS failed (${response.status}): ${errText}`);
    }

    // OpenAI's `opus` response_format returns a complete Ogg Opus container
    // (verified: `file` reports "Ogg data, Opus audio" for all TTS models).
    // Send straight to Telegram as audio/ogg — no ffmpeg re-mux needed.
    return Buffer.from(await response.arrayBuffer());
  }

  async isTTSAvailable(): Promise<boolean> {
    // OpenAI returns Ogg Opus directly — no ffmpeg dependency.
    return true;
  }

  getInfo() { return { provider: 'OpenAI Whisper' }; }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function checkFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (error) => resolve(!error));
  });
}

async function convertPcmToOggOpus(pcmBuffer: Buffer, tempDir: string): Promise<Buffer> {
  await mkdir(tempDir, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const inputFile = join(tempDir, `tts-${id}.raw`);
  const outputFile = join(tempDir, `tts-${id}.ogg`);
  await writeFile(inputFile, pcmBuffer);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-f', 's16le', '-ar', '16000', '-ac', '1',
        '-i', inputFile,
        '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg',
        outputFile,
      ], { timeout: 30000 }, (error) => {
        if (error) reject(new Error(`ffmpeg PCM→OGG failed: ${error.message}`));
        else resolve();
      });
    });
    return await readFile(outputFile);
  } finally {
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
  }
}

async function convertOpusToOggOpus(opusBuffer: Buffer, tempDir: string): Promise<Buffer> {
  await mkdir(tempDir, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const inputFile = join(tempDir, `tts-${id}.opus`);
  const outputFile = join(tempDir, `tts-${id}.ogg`);
  await writeFile(inputFile, opusBuffer);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', inputFile,
        '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg',
        outputFile,
      ], { timeout: 30000 }, (error) => {
        if (error) reject(new Error(`ffmpeg Opus→OGG failed: ${error.message}`));
        else resolve();
      });
    });
    return await readFile(outputFile);
  } finally {
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
  }
}
