import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const MAX_INCOMING_HISTORY = 50;

export const HISTORY_ROLES = ['user', 'assistant'] as const;
export type HistoryRole = (typeof HISTORY_ROLES)[number];

export class MessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content!: string;

  @IsISO8601()
  timestamp!: string;
}

export class HistoryMessageDto {
  @IsIn(HISTORY_ROLES)
  role!: HistoryRole;

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content!: string;

  @IsISO8601()
  timestamp!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ReplyOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  force_model?: string;

  @IsOptional()
  @IsBoolean()
  skip_validator?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  trace_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  request_id?: string;
}

export class ReplyRequestDto {
  @ApiProperty({ description: 'Business id from main backend; must match a previously pushed profile.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  business_id!: string;

  @ApiProperty({ description: 'Opaque conversation id; used in logs only.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  conversation_id!: string;

  @ApiProperty({ description: 'Opaque contact id (phone, IG handle, …); used in logs only.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  contact_id!: string;

  @ApiProperty({ example: 'whatsapp' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  channel!: string;

  @ValidateNested()
  @Type(() => MessageDto)
  message!: MessageDto;

  @ApiProperty({
    type: [HistoryMessageDto],
    description: 'Last N turns, oldest first. AI backend trims internally if needed.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_INCOMING_HISTORY)
  @ValidateNested({ each: true })
  @Type(() => HistoryMessageDto)
  history!: HistoryMessageDto[];

  @ApiPropertyOptional({ type: ReplyOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReplyOptionsDto)
  options?: ReplyOptionsDto;
}

// ───────── responses ─────────

export type ReplyStatus = 'replied' | 'escalate' | 'outside_hours';

export interface TriageSummary {
  intent: string;
  sentiment?: string;
  language: string;
}

export interface ReplyMetadata {
  triage?: TriageSummary;
  attempts?: number;
  validator_pass?: boolean;
  last_violations?: string[];
  model_used?: string;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms: number;
  trace_id?: string;
}

export interface ReplyResponseReplied {
  status: 'replied';
  reply: string;
  metadata: ReplyMetadata;
}

export interface ReplyResponseEscalate {
  status: 'escalate';
  reason: 'validator_exhausted' | 'triage_handoff' | 'keyword_match' | 'unknown';
  suggested_handoff_message: string;
  metadata: ReplyMetadata;
}

export interface ReplyResponseOutsideHours {
  status: 'outside_hours';
  reply: string;
  metadata: Pick<ReplyMetadata, 'latency_ms' | 'trace_id'>;
}

export type ReplyResponse =
  | ReplyResponseReplied
  | ReplyResponseEscalate
  | ReplyResponseOutsideHours;
