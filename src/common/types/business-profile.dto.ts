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
  ValidateNested,
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

export class ToneDto {
  @IsIn(TONE_STYLES)
  style!: ToneStyle;

  @IsString()
  @MaxLength(100)
  persona_name!: string;

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
  close!: string;
}

export class HoursDto {
  @IsString()
  @MaxLength(64)
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

export class CorrectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  wrong!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  right!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  context?: string;
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

}
