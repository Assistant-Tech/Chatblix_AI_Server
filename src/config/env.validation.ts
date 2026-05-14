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

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_URL!: string;

  @IsString()
  @MinLength(32)
  INTERNAL_API_TOKEN!: string;

  @IsString()
  OPENROUTER_API_KEY!: string;

  @IsOptional()
  @IsString()
  OPENROUTER_MODEL: string = 'anthropic/claude-haiku-4.5';

  @IsOptional()
  @IsString()
  KB_FILE: string = 'fresh-and-more.json';

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
  @IsBoolean()
  PIPELINE_LOG_CORPUS: boolean = true;
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
