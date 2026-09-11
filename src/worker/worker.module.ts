import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiReplyWorker } from './ai-reply.worker';
import { AiDigestWorker } from './ai-digest.worker';
import { ReplyModule } from '../reply/reply.module';
import { DigestModule } from '../digest/digest.module';
import { AppConfigService } from '../config/app-config.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      // Connects to BULLMQ_REDIS_URL — the shared Redis with main-backend.
      // This is separate from REDIS_URL (ai-backend's own Redis for caches).
      useFactory: (config: AppConfigService) => ({
        connection: { url: config.bullmqRedisUrl() },
      }),
      inject: [AppConfigService],
    }),
    BullModule.registerQueue({ name: 'ai.reply' }),
    // Separate queue from ai.reply so digest generation can never add latency to
    // — or contend for workers with — a live customer reply.
    BullModule.registerQueue({ name: 'ai.digest' }),
    ReplyModule,
    DigestModule,
  ],
  providers: [AiReplyWorker, AiDigestWorker],
})
export class WorkerModule {}
