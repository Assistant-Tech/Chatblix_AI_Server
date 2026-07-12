import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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

export class ExistingOrderItemDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class ExistingOrderDto {
  @IsString()
  @MaxLength(200)
  ref!: string;

  @IsString()
  @MaxLength(40)
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  paymentMethod?: string | null;

  @IsNumber()
  total!: number;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ExistingOrderItemDto)
  items!: ExistingOrderItemDto[];
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

  @ApiPropertyOptional({
    type: ExistingOrderDto,
    description: 'Set by main-backend when an order already exists for this conversation.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExistingOrderDto)
  existing_order?: ExistingOrderDto;

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

// Machine category for WHY the handoff happened. `ai_handoff` = the generator
// itself flagged handoff_required inside its <metadata> (in-band handoff), as
// opposed to a deterministic pre-generator rule.
export type EscalationReasonCode =
  | 'validator_exhausted'
  | 'triage_handoff'
  | 'keyword_match'
  | 'max_turns_exceeded'
  | 'negative_sentiment'
  | 'ai_handoff'
  | 'unknown';

export interface ReplyResponseEscalate {
  status: 'escalate';
  reason: EscalationReasonCode;
  suggested_handoff_message: string;
  // Human-readable explanation of WHY a human is needed (from triage.handoff_reason
  // or the generator's <metadata>.handoff_context). Surfaced to the operator queue.
  // Distinct from suggested_handoff_message, which is the customer-facing text.
  handoff_reason?: string | null;
  // The keyword that triggered a keyword_match escalation, when applicable.
  matched_trigger?: string | null;
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
