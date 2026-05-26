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
    this.logger.log(`Connected to Redis at ${this.config.redisUrl()}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  raw(): Redis {
    return this.client;
  }
}
