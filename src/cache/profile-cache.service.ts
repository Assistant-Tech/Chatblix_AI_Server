import { Injectable } from '@nestjs/common';
import { RedisClient } from './redis.client';

const PROFILE_TTL_SECONDS = 5 * 60;

@Injectable()
export class ProfileCacheService {
  constructor(private readonly redis: RedisClient) {}

  private key(businessId: string): string {
    return `profile:${businessId}`;
  }

  async get<T>(businessId: string): Promise<T | null> {
    const raw = await this.redis.raw().get(this.key(businessId));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async set(businessId: string, profile: unknown): Promise<void> {
    await this.redis.raw().set(this.key(businessId), JSON.stringify(profile), 'EX', PROFILE_TTL_SECONDS);
  }

  async invalidate(businessId: string): Promise<void> {
    await this.redis.raw().del(this.key(businessId));
  }
}
