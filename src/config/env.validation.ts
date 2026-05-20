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
  @MinLength(32)
  INTERNAL_API_TOKEN!: string;

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
  PIPELINE_GENERATOR_MODEL_HIGH_VALUE: string = 'anthropic/claude-opus-4.7';

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
