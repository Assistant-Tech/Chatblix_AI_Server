import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvSchema } from './env.validation';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvSchema, true>) {}

  port(): number {
    return this.config.get('PORT', { infer: true });
  }

  databaseUrl(): string {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  openrouterKey(): string {
    return this.config.get('OPENROUTER_API_KEY', { infer: true });
  }

  legacyModel(): string {
    return this.config.get('OPENROUTER_MODEL', { infer: true });
  }

  kbFile(): string {
    return this.config.get('KB_FILE', { infer: true });
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

  generatorModelHighValue(): string {
    return this.config.get('PIPELINE_GENERATOR_MODEL_HIGH_VALUE', { infer: true });
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

  shouldLogCorpus(): boolean {
    return this.config.get('PIPELINE_LOG_CORPUS', { infer: true });
  }
}
