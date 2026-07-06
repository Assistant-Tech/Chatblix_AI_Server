import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class RedisClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClient.name);
  private client!: Redis;

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new Redis(this.config.redisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis error: ${err.message}`, err.stack);
    });

    await this.client.connect();
    const pong = await this.client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis PING response: ${pong}`);
    }
    // Log host:port only — the full URL embeds the password.
    this.logger.log(`Connected to Redis at ${redisHost(this.config.redisUrl())}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  raw(): Redis {
    return this.client;
  }
}

/**
 * Extracts `host:port` from a Redis URL so the password embedded in the URL is
 * never written to logs. Falls back to a redacted marker if the URL can't be parsed.
 */
export function redisHost(url: string): string {
  try {
    return new URL(url).host || '[redacted]';
  } catch {
    return '[redacted]';
  }
}
