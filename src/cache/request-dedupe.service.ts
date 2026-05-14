import { Injectable, Logger } from '@nestjs/common';
import { RedisClient } from './redis.client';

const TTL_SECONDS = 60;

@Injectable()
export class RequestDedupeService {
  private readonly logger = new Logger(RequestDedupeService.name);

  constructor(private readonly redis: RedisClient) {}

  private key(requestId: string): string {
    return `request:${requestId}`;
  }

  /**
   * Returns the cached response if this request_id was seen in the last 60s,
   * otherwise null. JSON.parse failures surface as null + a log line.
   */
  async getCached<T>(requestId: string): Promise<T | null> {
    if (!requestId) return null;
    const raw = await this.redis.raw().get(this.key(requestId));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      this.logger.warn(`dedupe: corrupt cached response for ${requestId} — ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Stores the response under `request:{id}` with 60-second TTL, only if the
   * key doesn't already exist (`NX`). Lets concurrent retries lose the race
   * without overwriting the first responder's payload.
   */
  async storeOnce(requestId: string, response: unknown): Promise<void> {
    if (!requestId) return;
    await this.redis.raw().set(this.key(requestId), JSON.stringify(response), 'EX', TTL_SECONDS, 'NX');
  }
}
