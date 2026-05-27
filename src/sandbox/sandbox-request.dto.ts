import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BusinessProfileDto } from '../common/types/business-profile.dto';

export class SandboxMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;

  @IsISO8601()
  timestamp!: string;
}

export class SandboxHistoryEntryDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content!: string;

  @IsISO8601()
  timestamp!: string;
}

export class SandboxRequestDto {
  @ValidateNested()
  @Type(() => BusinessProfileDto)
  profile!: BusinessProfileDto;

  @ValidateNested()
  @Type(() => SandboxMessageDto)
  message!: SandboxMessageDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SandboxHistoryEntryDto)
  history?: SandboxHistoryEntryDto[];

  @IsOptional()
  @IsUUID()
  trace_id?: string;
}
