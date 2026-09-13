import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from '../pipeline/metrics.service';
import { LLMNoContentError, LLMRateLimitError, LLMServerError, LLMTimeoutError } from '../pipeline/llm-client.service';
import { AssistantAbortedError, AssistantError, AssistantOrchestratorService } from './assistant-orchestrator.service';
import type { AssistantErrorCode, AssistantErrorFrame, AssistantStreamRequest } from '../common/types/assistant.dto';

const ERROR_MESSAGES: Record<AssistantErrorCode, string> = {
  timeout: 'The assistant took too long to answer. Please try again.',
  provider_error: 'The AI service is unavailable right now. Please try again shortly.',
  budget_exceeded: 'That question needed more work than one answer allows. Try asking something narrower.',
  no_answer: 'The assistant could not come up with an answer. Try rephrasing the question.',
  internal: 'Something went wrong while answering. Please try again.',
};

/**
 * Writes SSE frames once the headers are out. After the flush no exception may
 * escape: AllExceptionsFilter would try to set a status on a response whose
 * headers are already sent. So `send()` is a no-op once the response has ended
 * or its socket is gone, and `end()` runs exactly once.
 */
export class SseWriter {
  private ended = false;

  constructor(private readonly res: Response) {}

  get closed(): boolean {
    return this.ended || this.res.writableEnded || this.res.destroyed;
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    try {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // The socket went away between the check and the write.
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.res.writableEnded || this.res.destroyed) return;
    try {
      this.res.end();
    } catch {
      // Already torn down.
    }
  }
}

/**
 * Maps one assistant turn onto the SSE response: orchestrator events become
 * frames; any failure becomes a single `error` frame; the response always ends.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly orchestrator: AssistantOrchestratorService,
    private readonly metrics: MetricsService,
  ) {}

  async stream(req: AssistantStreamRequest, res: Response, signal: AbortSignal): Promise<void> {
    const out = new SseWriter(res);
    try {
      for await (const ev of this.orchestrator.run(req, signal)) {
        out.send(ev.event, ev.data);
      }
    } catch (e) {
      if (e instanceof AssistantAbortedError || signal.aborted) {
        this.metrics.bump('assistant_aborted');
        this.logger.log(`assistant turn aborted by client business_id=${req.business_id} trace_id=${req.options.trace_id}`);
      } else {
        const frame = toErrorFrame(e);
        if (frame.code === 'timeout' || frame.code === 'budget_exceeded') this.metrics.bump('assistant_timeout');
        if (frame.code === 'provider_error') this.metrics.bump('assistant_provider_error');
        const err = e as Error;
        this.logger.error(
          `assistant turn failed code=${frame.code} business_id=${req.business_id} trace_id=${req.options.trace_id}: ${err?.message ?? String(e)}`,
          frame.code === 'internal' ? err?.stack : undefined,
        );
        out.send('error', frame);
      }
    } finally {
      out.end();
    }
  }
}

export function toErrorFrame(e: unknown): AssistantErrorFrame {
  const code: AssistantErrorCode =
    e instanceof AssistantError
      ? e.code
      : e instanceof LLMTimeoutError
        ? 'timeout'
        : e instanceof LLMRateLimitError || e instanceof LLMServerError || e instanceof LLMNoContentError
          ? 'provider_error'
          : 'internal';
  return { code, message: ERROR_MESSAGES[code] };
}
