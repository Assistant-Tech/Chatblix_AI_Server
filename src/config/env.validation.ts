import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export class EnvSchema {
  @IsOptional()
  @IsInt()
  @Min(1)
  PORT: number = 8000;

  // ai-backend's own Redis — prompt cache, profile cache, request dedupe
  @IsString()
  REDIS_URL!: string;

  // Shared Redis with main-backend — BullMQ job queue only
  @IsString()
  BULLMQ_REDIS_URL!: string;

  // main-backend internal API — cold cache profile fetch on Redis miss
  @IsString()
  MAIN_BACKEND_INTERNAL_URL!: string;

  @IsString()
  @MinLength(32)
  MAIN_BACKEND_INTERNAL_TOKEN!: string;

  @IsString()
  OPENROUTER_API_KEY!: string;

  @IsOptional()
  @IsString()
  OPENROUTER_MODEL: string = 'anthropic/claude-haiku-4.5';

  @IsOptional()
  @IsBoolean()
  USE_MULTI_MODEL_PIPELINE: boolean = true;

  @IsOptional()
  @IsString()
  PIPELINE_TRIAGE_MODEL: string = 'anthropic/claude-haiku-4.5';

  @IsOptional()
  @IsString()
  PIPELINE_GENERATOR_MODEL: string = 'anthropic/claude-sonnet-4.6';

  @IsOptional()
  @IsString()
  PIPELINE_VALIDATOR_MODEL: string = 'anthropic/claude-haiku-4.5';

  @IsOptional()
  @IsInt()
  @Min(100)
  PIPELINE_TRIAGE_TIMEOUT_MS: number = 4500;

  @IsOptional()
  @IsInt()
  @Min(100)
  PIPELINE_GENERATOR_TIMEOUT_MS: number = 10000;

  @IsOptional()
  @IsInt()
  @Min(100)
  PIPELINE_VALIDATOR_TIMEOUT_MS: number = 4500;

  @IsOptional()
  @IsInt()
  @Min(0)
  PIPELINE_MAX_RETRIES: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  MAX_HISTORY_TURNS: number = 10;

  // When true, the validator LLM call is skipped on low-risk turns (simple
  // greetings / factual answers with no price, closing, medical, complaint, or
  // handoff signal). Trades the per-turn quality gate for a saved Haiku call.
  // Default false → every turn is validated (current behavior).
  @IsOptional()
  @IsBoolean()
  PIPELINE_VALIDATE_RISKY_ONLY: boolean = false;

  // Hard wall-clock budget for one ai.reply job in the worker. Keep it ≥ triage +
  // (generator + validator) × (PIPELINE_MAX_RETRIES + 1) + headroom, otherwise valid
  // but slow turns are killed mid-flight and surface as job_timeout hard failures.
  // The default suits the fast Claude tier; raise it (see .env) for slower models.
  @IsOptional()
  @IsInt()
  @Min(1000)
  WORKER_JOB_TIMEOUT_MS: number = 45_000;
}

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const parsed = plainToInstance(EnvSchema, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(parsed, {
    skipMissingProperties: false,
    whitelist: true,
  });
  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors
        .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
        .join('\n')}`,
    );
  }
  return parsed;
}
