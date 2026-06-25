import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvSchema } from './env.validation';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvSchema, true>) {}

  port(): number {
    return this.config.get('PORT', { infer: true });
  }

  // ai-backend's own Redis (prompt cache, profile cache, dedupe)
  redisUrl(): string {
    return this.config.get('REDIS_URL', { infer: true });
  }

  // Shared Redis with main-backend (BullMQ job queue)
  bullmqRedisUrl(): string {
    return this.config.get('BULLMQ_REDIS_URL', { infer: true });
  }

  mainBackendInternalUrl(): string {
    return this.config.get('MAIN_BACKEND_INTERNAL_URL', { infer: true });
  }

  mainBackendInternalToken(): string {
    return this.config.get('MAIN_BACKEND_INTERNAL_TOKEN', { infer: true });
  }

  openrouterKey(): string {
    return this.config.get('OPENROUTER_API_KEY', { infer: true });
  }

  legacyModel(): string {
    return this.config.get('OPENROUTER_MODEL', { infer: true });
  }

  isPipelineEnabled(): boolean {
    return this.config.get('USE_MULTI_MODEL_PIPELINE', { infer: true });
  }

  triageModel(): string {
    return this.config.get('PIPELINE_TRIAGE_MODEL', { infer: true });
  }

  generatorModel(): string {
    return this.config.get('PIPELINE_GENERATOR_MODEL', { infer: true });
  }

  validatorModel(): string {
    return this.config.get('PIPELINE_VALIDATOR_MODEL', { infer: true });
  }

  triageTimeoutMs(): number {
    return this.config.get('PIPELINE_TRIAGE_TIMEOUT_MS', { infer: true });
  }

  generatorTimeoutMs(): number {
    return this.config.get('PIPELINE_GENERATOR_TIMEOUT_MS', { infer: true });
  }

  validatorTimeoutMs(): number {
    return this.config.get('PIPELINE_VALIDATOR_TIMEOUT_MS', { infer: true });
  }

  maxRetries(): number {
    return this.config.get('PIPELINE_MAX_RETRIES', { infer: true });
  }

  /**
   * Hard wall-clock budget for a single ai.reply job in the worker. Must comfortably
   * exceed the pipeline's real worst case — triage + (generator + validator) per
   * attempt across (maxRetries + 1) attempts — or slow-but-valid turns are killed
   * mid-flight and surface as job_timeout hard failures.
   */
  workerJobTimeoutMs(): number {
    return this.config.get('WORKER_JOB_TIMEOUT_MS', { infer: true });
  }

  maxHistoryTurns(): number {
    return this.config.get('MAX_HISTORY_TURNS', { infer: true });
  }
}
