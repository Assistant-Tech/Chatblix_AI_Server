import { Injectable, Logger } from '@nestjs/common';
import {
  ChatJsonOptions,
  ChatJsonResult,
  ChatJsonUsage,
  ChatStreamOptions,
  ChatStreamEvent,
  OpenRouterClient,
  OpenRouterError,
} from './openrouter.client';

export class LLMTimeoutError extends Error {
  readonly kind = 'timeout' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMRateLimitError extends Error {
  readonly kind = 'rate_limit' as const;
  readonly retry_after_s?: number;
  constructor(message: string, retry_after_s?: number) {
    super(message);
    this.name = 'LLMRateLimitError';
    this.retry_after_s = retry_after_s;
  }
}

export class LLMServerError extends Error {
  readonly kind = 'server_error' as const;
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LLMServerError';
    this.status = status;
  }
}

/**
 * The provider returned a well-formed 200 response that simply carries no
 * assistant content (e.g. a reasoning model that burned its token budget on
 * reasoning and emitted no final message). This is NOT transient — retrying the
 * same deterministic prompt reproduces it — so it is deliberately non-retriable
 * and lets callers fall back immediately (validator/triage soft-pass) instead of
 * wasting the full retry budget on a guaranteed-empty result.
 */
export class LLMNoContentError extends Error {
  readonly kind = 'no_content' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LLMNoContentError';
  }
}

export interface CallContext {
  business_id?: string;
  trace_id?: string;
  stage?: 'triage' | 'generator' | 'validator';
}

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4000;

@Injectable()
export class LLMClientService {
  private readonly logger = new Logger(LLMClientService.name);

  constructor(private readonly upstream: OpenRouterClient) {}

  async chatJson(opts: ChatJsonOptions, callCtx: CallContext = {}): Promise<ChatJsonResult> {
    return this.withRetry(callCtx, async () => {
      const start = Date.now();
      const result = await this.upstream.chatJson(opts);
      this.logCall(opts.model, callCtx, start, result);
      return result;
    });
  }

  /**
   * For streaming we don't retry mid-stream — too easy to double-yield tokens.
   * Retries only happen on connection establishment failure, which we surface
   * by attempting the first iteration eagerly.
   */
  async *chatStream(opts: ChatStreamOptions, callCtx: CallContext = {}): AsyncGenerator<ChatStreamEvent> {
    const start = Date.now();
    let firstChunkSeen = false;

    try {
      for await (const chunk of this.upstream.chatStream(opts)) {
        firstChunkSeen = true;
        yield chunk;
      }
      this.logCall(opts.model, callCtx, start, null);
    } catch (e) {
      if (firstChunkSeen) {
        // Already yielded data — surface the error as-is; retrying would duplicate.
        throw this.translate(e);
      }
      // Pre-first-chunk failure → translate to typed error. ReplyService can
      // decide whether to retry by re-invoking chatStream.
      throw this.translate(e);
    }
  }

  private async withRetry<T>(callCtx: CallContext, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const typed = this.translate(e);
        const retriable = isRetriable(typed);
        if (!retriable || attempt === MAX_ATTEMPTS) {
          this.logger.warn(
            `llm.fail stage=${callCtx.stage ?? '-'} business_id=${callCtx.business_id ?? '-'} ` +
              `trace_id=${callCtx.trace_id ?? '-'} attempt=${attempt}/${MAX_ATTEMPTS} ` +
              `kind=${typed instanceof Error ? typed.constructor.name : 'unknown'} msg="${(typed as Error).message}"`,
          );
          throw typed;
        }
        const wait = jitter(Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS));
        this.logger.log(
          `llm.retry stage=${callCtx.stage ?? '-'} attempt=${attempt}/${MAX_ATTEMPTS} ` +
            `wait_ms=${wait} kind=${(typed as Error).constructor.name}`,
        );
        await sleep(wait);
      }
    }
    throw this.translate(lastErr);
  }

  private translate(e: unknown): Error {
    if (
      e instanceof LLMTimeoutError ||
      e instanceof LLMRateLimitError ||
      e instanceof LLMServerError ||
      e instanceof LLMNoContentError
    ) {
      return e;
    }
    if (e instanceof OpenRouterError) {
      if (e.kind === 'timeout') return new LLMTimeoutError(e.message);
      // A 200 with no usable content — non-retriable; let the caller fall back now.
      if (e.kind === 'no_content') return new LLMNoContentError(e.message);
      if (e.status === 429) {
        return new LLMRateLimitError(e.message);
      }
      if (e.status && e.status >= 500) {
        return new LLMServerError(e.message, e.status);
      }
      return new LLMServerError(e.message, e.status);
    }
    if (e instanceof Error) return e;
    return new Error(String(e));
  }

  private logCall(
    model: string,
    callCtx: CallContext,
    startMs: number,
    result: ChatJsonResult | null,
  ): void {
    const latencyMs = Date.now() - startMs;
    const usage: ChatJsonUsage | null = result?.usage ?? null;
    const tokensIn = usage?.prompt_tokens ?? null;
    const tokensOut = usage?.completion_tokens ?? null;
    this.logger.log(
      `llm.ok stage=${callCtx.stage ?? '-'} model=${model} ` +
        `business_id=${callCtx.business_id ?? '-'} trace_id=${callCtx.trace_id ?? '-'} ` +
        `latency_ms=${latencyMs} tokens_in=${tokensIn ?? '-'} tokens_out=${tokensOut ?? '-'}`,
    );
  }
}

function isRetriable(err: Error): boolean {
  return err instanceof LLMTimeoutError || err instanceof LLMRateLimitError || err instanceof LLMServerError;
}

function jitter(ms: number): number {
  return Math.round(ms * (0.7 + Math.random() * 0.6));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
