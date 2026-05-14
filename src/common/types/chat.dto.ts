import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ChatStreamRequestDto {
  @ApiProperty({
    description: 'Stable identifier for the conversation. The same `session_id` retrieves prior history and lead state.',
    example: 'session-abc-123',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  session_id!: string;

  @ApiProperty({
    description: "The customer's most recent message. English, Romanized Nepali, Devanagari Nepali, or code-mixed.",
    example: 'Namaste, face mask ko price kati ho?',
    minLength: 1,
    maxLength: 8000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @ApiPropertyOptional({
    description: 'Override the knowledge-base file used for business context (defaults to env `KB_FILE`).',
    example: 'fresh-and-more.json',
  })
  @IsOptional()
  @IsString()
  kb_file?: string;
}

export class ChatJsonResponseDto {
  @ApiProperty({
    description: 'Raw XML/JSON candidate produced by the generator (with `<reply>` and `<metadata>` tags).',
    example: '<reply>Hajur, face mask ko price NPR 950 ho.</reply><metadata>{"intent":"buying"}</metadata>',
  })
  raw!: string;

  @ApiProperty({
    description: "Final reply text shown to the customer (extracted from `<reply>...</reply>`).",
    example: 'Hajur, face mask ko price NPR 950 ho.',
  })
  reply!: string;

  @ApiProperty({
    description: 'Final agent metadata (lead score, stage, intent, extracted contact fields, etc.).',
    type: 'object',
    additionalProperties: true,
    example: {
      lead_score: 35,
      stage: 'warm',
      intent: 'buying',
      next_step: 'recommend',
      extracted_data: { phone: '9812345678' },
      handoff_required: false,
      suggested_reply_language: 'romanized_ne',
      tags: ['price_inquiry'],
    },
  })
  metadata!: Record<string, unknown>;
}

export class HealthResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ example: 'anthropic/claude-haiku-4.5' })
  model!: string;

  @ApiProperty({ example: 'openrouter' })
  provider!: string;

  @ApiProperty({ example: true })
  pipeline_enabled!: boolean;
}

export class PipelineModelsDto {
  @ApiProperty({ example: 'anthropic/claude-haiku-4.5' })
  triage!: string;

  @ApiProperty({ example: 'anthropic/claude-sonnet-4.6' })
  generator!: string;

  @ApiProperty({ example: 'anthropic/claude-haiku-4.5' })
  validator!: string;
}

export class PipelineHealthResponseDto {
  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ type: PipelineModelsDto })
  models!: PipelineModelsDto;

  @ApiProperty({
    description: 'In-process counters since boot. Persistent aggregation lives in the `TurnLog` table.',
    type: 'object',
    additionalProperties: true,
    example: {
      total_turns: 42,
      turn_pass_first_try: 38,
      turn_pass_after_retry: 3,
      turn_ship_with_violations: 1,
      violations_by_rule: { '1': 2, '7': 1 },
    },
  })
  counters!: Record<string, unknown>;
}
