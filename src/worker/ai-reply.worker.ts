import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { ReplyService } from '../reply/reply.service';
import { AppConfigService } from '../config/app-config.service';
import type { ReplyRequestDto } from '../common/types/reply.dto';
import type { AiReplyJobResult } from '../common/types/turn-log.types';

@Processor('ai.reply', {
  concurrency: 5,
  stalledInterval: 30_000,
  maxStalledCount: 2,
})
@Injectable()
export class AiReplyWorker extends WorkerHost {
  private readonly logger = new Logger(AiReplyWorker.name);

  constructor(
    private readonly replyService: ReplyService,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  async process(job: Job<ReplyRequestDto>): Promise<AiReplyJobResult> {
    this.logger.log(
      `processing job=${job.id} business_id=${job.data.business_id} conversation_id=${job.data.conversation_id}`,
    );

    try {
      const result = await withTimeout(
        this.replyService.handle(job.data),
        this.config.workerJobTimeoutMs(),
      );
      this.logger.log(
        `completed job=${job.id} status=${result.response.status} duration_ms=${result.turnLog.durationMs}`,
      );
      return result;
    } catch (e) {
      const err = e as Error;
      // NotFoundException means the BusinessProfile doesn't exist — retrying won't help.
      // Mark as unrecoverable so BullMQ skips remaining attempts and fails immediately.
      if (e instanceof NotFoundException) {
        this.logger.warn(
          `profile not found job=${job.id} business_id=${job.data.business_id} — marking unrecoverable`,
        );
        throw new UnrecoverableError('profile_not_found');
      }
      this.logger.error(
        `job failed job=${job.id} business_id=${job.data.business_id} conversation_id=${job.data.conversation_id} attempt=${job.attemptsMade}: ${err.message}`,
        err.stack,
      );
      throw e;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`job_timeout_${ms}ms`)), ms),
    ),
  ]);
}
