import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export const TONE_STYLES = ['formal', 'friendly', 'casual'] as const;
export type ToneStyle = (typeof TONE_STYLES)[number];

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function hhmmToMinutes(v: string): number {
  const m = HHMM.exec(v);
  if (!m) return NaN;
  const [h, min] = v.split(':').map(Number);
  return h * 60 + min;
}

// `close` must be strictly after `open`. Format is enforced separately by @Matches,
// so an unparseable value passes here to avoid a confusing duplicate error.
@ValidatorConstraint({ name: 'openBeforeClose', async: false })
export class OpenBeforeCloseConstraint implements ValidatorConstraintInterface {
  validate(close: unknown, args: ValidationArguments): boolean {
    const open = (args.object as ScheduleEntryDto).open;
    const o = hhmmToMinutes(String(open));
    const c = hhmmToMinutes(String(close));
    if (Number.isNaN(o) || Number.isNaN(c)) return true;
    return o < c;
  }
  defaultMessage(): string {
    return 'open must be earlier than close (HH:MM, 24h)';
  }
}

function isValidIanaTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    // Throws RangeError for an unknown zone. This accepts every zone the runtime
    // recognizes (canonical names + aliases), which is exactly what we want —
    // Intl.supportedValuesOf lists only canonical names and misses valid aliases.
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: 'ianaTimeZone', async: false })
export class IanaTimeZoneConstraint implements ValidatorConstraintInterface {
  validate(tz: unknown): boolean {
    return typeof tz === 'string' && isValidIanaTimeZone(tz);
  }
  defaultMessage(): string {
    return 'timezone must be a valid IANA time zone (e.g. Asia/Kathmandu)';
  }
}

export class ToneDto {
  @IsIn(TONE_STYLES)
  style!: ToneStyle;

  @IsString()
  @MaxLength(100)
  persona_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  persona_desc?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  closing_statement?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  do!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  dont!: string[];
}

export class ScheduleEntryDto {
  @IsIn(WEEKDAYS)
  day!: Weekday;

  @Matches(HHMM, { message: 'open must be HH:MM (24h)' })
  open!: string;

  @Matches(HHMM, { message: 'close must be HH:MM (24h)' })
  @Validate(OpenBeforeCloseConstraint)
  close!: string;
}

export class HoursDto {
  @IsString()
  @MaxLength(64)
  @Validate(IanaTimeZoneConstraint)
  timezone!: string;

  @IsArray()
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => ScheduleEntryDto)
  schedule!: ScheduleEntryDto[];

  @IsString()
  @MaxLength(500)
  holiday_message!: string;
}

export class FaqDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  answer!: string;
}

export class PoliciesDto {
  @IsString()
  @MaxLength(2000)
  return_policy!: string;

  @IsString()
  @MaxLength(2000)
  delivery_policy!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  payment_methods!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  custom?: string[];
}

export class EscalationDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  triggers!: string[];

  @IsString()
  @MaxLength(500)
  handoff_message!: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  max_turns?: number;

  @IsOptional()
  @IsIn(['negative', 'very_negative'])
  sentiment_threshold?: 'negative' | 'very_negative';
}

export class ProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}

export class LocationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  hours?: string;
}

export class OfferDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  details!: string;

  @IsOptional()
  @IsISO8601()
  valid_until?: string;
}

export class CorrectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  corrected!: string;
}

/**
 * Per-tenant override for the closing (order/booking/quote) flow. When present it
 * replaces the compiler's built-in `business_type` enum, so tenant types the enum
 * doesn't cover — courses, travel, real-estate, rentals — can define their own
 * capture fields and vocabulary instead of falling back to parcel/delivery
 * phrasing that's wrong for an intangible. Every field is optional; the compiler
 * only overrides the parts that are provided.
 */
export class ClosingFlowDto {
  // Short label for the flow, e.g. "delivery", "booking", "quote", "enrollment".
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  // Fields to capture on the first closing turn (STAGE 1), e.g. ["naam","phone","preferred date"].
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  stage1_captures?: string[];

  // Fields to confirm on the final turn (STAGE 3), e.g. ["naam","service","phone","datetime"].
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  stage3_confirms?: string[];

  // Domain phrasing cues, e.g. ["'booking confirm garchu' not 'parcel pathaucha'"].
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  vocabulary?: string[];
}

export class BusinessProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  // Free-form domain hint used by the compiler to inject a short
  // domain-adaptation cue into the per-tenant system prompt. Not enum'd on
  // purpose — the taxonomy isn't stable yet. Common values today:
  // "skincare", "clothing", "food", "salon", "electronics", "service".
  @IsOptional()
  @IsString()
  @MaxLength(50)
  business_type?: string;

  @IsString()
  @MaxLength(16)
  language!: string;

  @ValidateNested()
  @Type(() => ToneDto)
  tone!: ToneDto;

  @ValidateNested()
  @Type(() => HoursDto)
  hours!: HoursDto;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FaqDto)
  faqs!: FaqDto[];

  @ValidateNested()
  @Type(() => PoliciesDto)
  policies!: PoliciesDto;

  @ValidateNested()
  @Type(() => EscalationDto)
  escalation!: EscalationDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProductDto)
  product_catalog?: ProductDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LocationDto)
  locations?: LocationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OfferDto)
  current_offers?: OfferDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CorrectionDto)
  corrections?: CorrectionDto[];

  @IsOptional()
  @IsBoolean()
  emoji_allowed?: boolean;

  // Explicit per-tenant tool capability list, resolved and published by
  // main-backend (see ai-backend/docs/TOOL_CAPABILITY_ARCHITECTURE.md). When
  // present it is authoritative; when absent, tool gating falls back to the
  // legacy profile heuristic. Tool names match src/pipeline/tools.registry.ts.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  enabled_tools?: string[];

  // Optional per-tenant closing-flow override. When present, the compiler renders
  // the closing section from this instead of the built-in business_type enum.
  @IsOptional()
  @ValidateNested()
  @Type(() => ClosingFlowDto)
  closing_flow?: ClosingFlowDto;

}
