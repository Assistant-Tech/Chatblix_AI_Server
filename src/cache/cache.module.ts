import { Global, Module } from '@nestjs/common';
import { RedisClient } from './redis.client';
import { PromptCacheService } from './prompt-cache.service';
import { ProfileCacheService } from './profile-cache.service';

@Global()
@Module({
  providers: [RedisClient, PromptCacheService, ProfileCacheService],
  exports: [RedisClient, PromptCacheService, ProfileCacheService],
})
export class CacheModule {}
