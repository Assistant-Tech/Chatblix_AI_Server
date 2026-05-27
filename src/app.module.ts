import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { BusinessModule } from './business/business.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { ReplyModule } from './reply/reply.module';
import { WorkerModule } from './worker/worker.module';
import { HealthModule } from './health/health.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule,
    CacheModule,
    AuthModule,
    BusinessModule,
    PipelineModule,
    ReplyModule,
    WorkerModule,
    HealthModule,
    SandboxModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
