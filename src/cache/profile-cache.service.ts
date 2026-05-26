import { Injectable, Logger } from '@nestjs/common';
import { RedisClient } from './redis.client';

const PROFILE_TTL_SECONDS = 5 * 60;

@Injectable()
export class ProfileCacheService {
  private readonly logger = new Logger(ProfileCacheService.name);

  constructor(private readonly redis: RedisClient) {}

  private key(businessId: string): string {
    return `profile:${businessId}`;
  }

  async get<T>(businessId: string): Promise<T | null> {
    const raw = await this.redis.raw().get(this.key(businessId));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      this.logger.warn(`profile cache: corrupt entry for ${businessId} — ${(e as Error).message}`);
      return null;
    }
  }

  async set(businessId: string, profile: unknown): Promise<void> {
    await this.redis.raw().set(this.key(businessId), JSON.stringify(profile), 'EX', PROFILE_TTL_SECONDS);
  }

  async invalidate(businessId: string): Promise<void> {
    await this.redis.raw().del(this.key(businessId));
  }
}
