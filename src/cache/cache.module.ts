import { Global, Module } from '@nestjs/common';
import { RedisClient } from './redis.client';
import { PromptCacheService } from './prompt-cache.service';
import { ProfileCacheService } from './profile-cache.service';
import { RequestDedupeService } from './request-dedupe.service';

@Global()
@Module({
  providers: [RedisClient, PromptCacheService, ProfileCacheService, RequestDedupeService],
  exports: [RedisClient, PromptCacheService, ProfileCacheService, RequestDedupeService],
})
export class CacheModule {}
