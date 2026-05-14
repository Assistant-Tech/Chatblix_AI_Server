import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './auth/auth.module';
import { BusinessModule } from './business/business.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { ReplyModule } from './reply/reply.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CacheModule,
    AuthModule,
    BusinessModule,
    PipelineModule,
    ReplyModule,
    HealthModule,
  ],
})
export class AppModule {}
