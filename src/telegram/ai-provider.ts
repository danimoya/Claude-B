// AI provider abstraction for prompt optimization
// Supports Anthropic (direct) and OpenRouter (via Anthropic SDK with custom baseURL)

import Anthropic from '@anthropic-ai/sdk';

export interface SessionContext {
  sessionName?: string;
  goal?: string;
  lastOutput?: string;
  status: string;
}

export interface AIProviderConfig {
  provider: 'anthropic' | 'openrouter';
  apiKey: string;
  model?: string;
}

const SYSTEM_PROMPT = `You are a prompt optimizer for Claude Code (an AI coding assistant that runs terminal commands and edits files).
Given a voice transcript and optional session context, produce a clear, actionable prompt.
Fix speech recognition errors, remove filler words, and add specificity from the context when relevant.
Keep the user's intent intact — do not add requirements they didn't mention.
Return ONLY the optimized prompt text, nothing else. No preamble, no explanation.`;

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openrouter: 'openrouter/auto',
};

export interface AIProvider {
  optimizePrompt(transcript: string, context?: SessionContext): Promise<string>;
  getInfo(): { provider: string; model: string };
}

export function createAIProvider(config: AIProviderConfig): AIProvider {
  const model = config.model || DEFAULT_MODELS[config.provider] || 'claude-haiku-4-5-20251001';

  const clientOptions: Anthropic.ClientOptions = {
    apiKey: config.apiKey,
  };

  if (config.provider === 'openrouter') {
    clientOptions.baseURL = 'https://openrouter.ai/api/v1';
  }

  const client = new Anthropic(clientOptions);

  return {
    async optimizePrompt(transcript: string, context?: SessionContext): Promise<string> {
      const parts: string[] = [];

      if (context) {
        parts.push('Session context:');
        if (context.sessionName) parts.push(`  Session: ${context.sessionName}`);
        if (context.goal) parts.push(`  Goal: ${context.goal}`);
        if (context.status) parts.push(`  Status: ${context.status}`);
        if (context.lastOutput) {
          parts.push(`  Last output (tail):\n${context.lastOutput.slice(-1500)}`);
        }
        parts.push('');
      }

      parts.push(`Voice transcript: "${transcript}"`);

      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: parts.join('\n') }],
      });

      const block = response.content[0];
      if (block.type === 'text') {
        return block.text.trim();
      }
      return transcript; // Fallback to raw transcript
    },

    getInfo() {
      return { provider: config.provider, model };
    },
  };
}
