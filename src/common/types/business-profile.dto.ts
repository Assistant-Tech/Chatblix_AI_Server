import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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
  delivery_info!: string;

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
}

export class BusinessProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

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
}
