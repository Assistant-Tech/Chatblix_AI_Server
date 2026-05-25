import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ReplyService } from '../reply/reply.service';
import type { ReplyRequestDto } from '../common/types/reply.dto';
import type { AiReplyJobResult } from '../common/types/turn-log.types';

const JOB_TIMEOUT_MS = 45_000;

@Processor('ai.reply', {
  concurrency: 5,
  stalledInterval: 30_000,
  maxStalledCount: 2,
})
@Injectable()
export class AiReplyWorker extends WorkerHost {
  private readonly logger = new Logger(AiReplyWorker.name);

  constructor(private readonly replyService: ReplyService) {
    super();
  }

  async process(job: Job<ReplyRequestDto>): Promise<AiReplyJobResult> {
    this.logger.log(
      `processing job=${job.id} business_id=${job.data.business_id} conversation_id=${job.data.conversation_id}`,
    );

    const result = await withTimeout(this.replyService.handle(job.data), JOB_TIMEOUT_MS);

    this.logger.log(
      `completed job=${job.id} status=${result.response.status} duration_ms=${result.turnLog.durationMs}`,
    );

    return result;
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
