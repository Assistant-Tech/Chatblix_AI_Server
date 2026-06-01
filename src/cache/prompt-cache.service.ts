import { Injectable } from '@nestjs/common';
import { RedisClient } from './redis.client';

@Injectable()
export class PromptCacheService {
  constructor(private readonly redis: RedisClient) {}

  private key(businessId: string): string {
    return `prompt:${businessId}`;
  }

  async get(businessId: string): Promise<string | null> {
    return this.redis.raw().get(this.key(businessId));
  }

  async set(businessId: string, compiledPrompt: string, ttlSeconds = 600): Promise<void> {
    await this.redis.raw().set(this.key(businessId), compiledPrompt, 'EX', ttlSeconds);
  }

  async invalidate(businessId: string): Promise<void> {
    await this.redis.raw().del(this.key(businessId));
  }
}
