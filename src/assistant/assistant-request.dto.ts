import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  AssistantDigestContext,
  AssistantHistoryEntry,
  AssistantStreamRequest,
} from '../common/types/assistant.dto';
import type { DigestStats } from '../common/types/digest.dto';

// Validates POST /assistant/stream, in the style of SandboxRequestDto. The global
// ValidationPipe runs with whitelist + forbidNonWhitelisted, so an unexpected key
// anywhere in the declared shape is a 400 before any SSE header is written.
//
// The caps keep the body under Express's default 100 KB limit: main-backend
// sends at most 8 prior question/answer pairs within a 24k-char budget.

export const MAX_HISTORY_ENTRIES = 16;
export const MAX_HISTORY_CONTENT_CHARS = 8000;
export const MAX_QUESTION_CHARS = 2000;

export class AssistantWindowDto {
  @IsISO8601()
  start!: string;

  @IsISO8601()
  end!: string;

  @IsNumber()
  @Min(0)
  @Max(48)
  hours!: number;
}

export class AssistantDigestDto implements AssistantDigestContext {
  @IsUUID()
  id!: string;

  @IsIn(['READY', 'FAILED'])
  status!: string;

  @ValidateNested()
  @Type(() => AssistantWindowDto)
  window!: AssistantWindowDto;

  // main-backend caps the stored summary at 2000 chars and 8 × 300-char items.
  @IsString()
  @MaxLength(2000)
  summary!: string;

  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  attentionItems!: string[];

  // The digest's own stats object, passed through to the model as context.
  @IsObject()
  stats!: DigestStats;
}

export class AssistantHistoryEntryDto implements AssistantHistoryEntry {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(MAX_HISTORY_CONTENT_CHARS)
  content!: string;
}

export class AssistantMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_QUESTION_CHARS)
  content!: string;
}

export class AssistantOptionsDto {
  @IsUUID()
  trace_id!: string;

  @IsUUID()
  thread_id!: string;
}

export class AssistantStreamRequestDto implements AssistantStreamRequest {
  @IsUUID()
  business_id!: string;

  @IsString()
  @MaxLength(200)
  business_name!: string;

  @IsString()
  @MaxLength(32)
  language!: string;

  @IsISO8601()
  now!: string;

  @ValidateNested()
  @Type(() => AssistantDigestDto)
  digest!: AssistantDigestDto;

  @IsArray()
  @ArrayMaxSize(MAX_HISTORY_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => AssistantHistoryEntryDto)
  history!: AssistantHistoryEntryDto[];

  @ValidateNested()
  @Type(() => AssistantMessageDto)
  message!: AssistantMessageDto;

  @ValidateNested()
  @Type(() => AssistantOptionsDto)
  options!: AssistantOptionsDto;
}
