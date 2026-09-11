import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { DigestService } from '../digest/digest.service';
import { AppConfigService } from '../config/app-config.service';
import { isDigestRequest, type AiDigestJobResult, type DigestRequestDto } from '../common/types/digest.dto';

/**
 * Consumes `ai.digest`. A separate queue and a separate worker from
 * `ai.reply` on purpose: a digest must never sit in front of a customer waiting
 * on a reply, and its low concurrency caps how much of the process it can take
 * while replies run at 5.
 */
@Processor('ai.digest', {
  concurrency: 2,
  stalledInterval: 30_000,
  maxStalledCount: 2,
})
@Injectable()
export class AiDigestWorker extends WorkerHost {
  private readonly logger = new Logger(AiDigestWorker.name);

  constructor(
    private readonly digestService: DigestService,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  async process(job: Job<DigestRequestDto>): Promise<AiDigestJobResult> {
    // A malformed payload is a contract break between the two backends, not a
    // transient failure — retrying it three times just delays the log line.
    if (!isDigestRequest(job.data)) {
      this.logger.error(`malformed digest payload job=${job.id} — marking unrecoverable`);
      throw new UnrecoverableError('invalid_digest_payload');
    }

    this.logger.log(
      `processing digest job=${job.id} business_id=${job.data.business_id} window=${job.data.window.start}..${job.data.window.end}`,
    );

    try {
      const result = await withTimeout(this.digestService.handle(job.data), this.config.digestJobTimeoutMs());
      this.logger.log(
        `completed digest job=${job.id} items=${result.attentionItems.length} fallback=${result.meta.fallbackUsed} duration_ms=${result.meta.durationMs}`,
      );
      return result;
    } catch (e) {
      const err = e as Error;
      this.logger.error(
        `digest job failed job=${job.id} business_id=${job.data.business_id} attempt=${job.attemptsMade}: ${err.message}`,
        err.stack,
      );
      throw e;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`digest_job_timeout_${ms}ms`)), ms);
    // Don't hold the event loop open — a SIGTERM must not wait out the budget.
    id.unref?.();
  });
  return Promise.race([promise.finally(() => clearTimeout(id)), timeout]);
}
