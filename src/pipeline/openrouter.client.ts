import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export type OpenRouterErrorKind = 'timeout' | 'api_error' | 'no_content' | 'config';

export class OpenRouterError extends Error {
  kind: OpenRouterErrorKind;
  status?: number;
  raw?: unknown;

  constructor(message: string, kind: OpenRouterErrorKind, status?: number, raw?: unknown) {
    super(message);
    this.name = 'OpenRouterError';
    this.kind = kind;
    this.status = status;
    this.raw = raw;
  }
}

export interface ChatJsonOptions {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: { type: string };
  timeoutMs?: number;
}

export interface ChatJsonUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface ChatJsonResult {
  text: string;
  raw: unknown;
  usage: ChatJsonUsage | null;
}

export interface ChatStreamOptions extends ChatJsonOptions {
  prefill?: string;
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<{ type: string; text: string; cache_control?: { type: string } }>;
}

@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);

  constructor(private readonly config: AppConfigService) {}

  private authHeaders(): Record<string, string> {
    const key = this.config.openrouterKey();
    if (!key) {
      throw new OpenRouterError('OPENROUTER_API_KEY not configured', 'config');
    }
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
  }

  private systemMessage(text: string): OpenRouterMessage {
    return {
      role: 'system',
      content: [
        {
          type: 'text',
          text,
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
  }

  private userMessage(text: string): OpenRouterMessage {
    return { role: 'user', content: text };
  }

  private assistantPrefillMessage(text: string): OpenRouterMessage {
    return { role: 'assistant', content: text };
  }

  async chatJson(opts: ChatJsonOptions): Promise<ChatJsonResult> {
    const {
      model,
      system,
      user,
      temperature = 0.1,
      maxTokens = 512,
      stopSequences,
      responseFormat,
      timeoutMs = 5000,
    } = opts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body: Record<string, unknown> = {
      model,
      messages: [this.systemMessage(system), this.userMessage(user)],
      temperature,
      max_tokens: maxTokens,
    };
    if (stopSequences) body.stop = stopSequences;
    if (responseFormat) body.response_format = responseFormat;

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        throw new OpenRouterError(`OpenRouter request timed out after ${timeoutMs}ms`, 'timeout');
      }
      throw new OpenRouterError(`OpenRouter request failed: ${err?.message || e}`, 'api_error');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new OpenRouterError(
        `OpenRouter returned ${response.status}: ${errText.slice(0, 200)}`,
        'api_error',
        response.status,
      );
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new OpenRouterError('OpenRouter returned no content', 'no_content', undefined, json);
    }
    const rawUsage = json?.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
    const usage: ChatJsonUsage | null = rawUsage
      ? { prompt_tokens: rawUsage.prompt_tokens ?? null, completion_tokens: rawUsage.completion_tokens ?? null }
      : null;
    return { text, raw: json, usage };
  }

  async *chatStream(opts: ChatStreamOptions): AsyncGenerator<string> {
    const {
      model,
      system,
      user,
      temperature = 0.7,
      maxTokens = 400,
      stopSequences,
      timeoutMs = 8000,
      prefill,
    } = opts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const messages: OpenRouterMessage[] = [this.systemMessage(system), this.userMessage(user)];
    if (prefill) messages.push(this.assistantPrefillMessage(prefill));

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };
    if (stopSequences) body.stop = stopSequences;

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { ...this.authHeaders(), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        throw new OpenRouterError(`OpenRouter stream timed out after ${timeoutMs}ms`, 'timeout');
      }
      throw new OpenRouterError(`OpenRouter stream failed: ${err?.message || e}`, 'api_error');
    }

    if (!response.ok || !response.body) {
      clearTimeout(timer);
      const errText = await response.text().catch(() => '');
      throw new OpenRouterError(
        `OpenRouter stream returned ${response.status}: ${errText.slice(0, 200)}`,
        'api_error',
        response.status,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buf.indexOf('\n')) !== -1) {
          const rawLine = buf.slice(0, nlIdx).replace(/\r$/, '');
          buf = buf.slice(nlIdx + 1);

          if (!rawLine.startsWith('data:')) continue;
          const data = rawLine.slice(5).trim();
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') return;
            continue;
          }
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              yield delta;
            }
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch (e) {
      // AbortError thrown by reader.read() when the AbortController fires mid-stream.
      // Wrap it the same way as the pre-connect abort so callers see a consistent timeout error.
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        throw new OpenRouterError(`OpenRouter stream timed out after ${timeoutMs}ms`, 'timeout');
      }
      throw new OpenRouterError(`OpenRouter stream failed during read: ${err?.message || String(e)}`, 'api_error');
    } finally {
      clearTimeout(timer);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }
}
