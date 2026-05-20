import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiReplyWorker } from './ai-reply.worker';
import { ReplyModule } from '../reply/reply.module';
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
    ReplyModule,
  ],
  providers: [AiReplyWorker],
})
export class WorkerModule {}
