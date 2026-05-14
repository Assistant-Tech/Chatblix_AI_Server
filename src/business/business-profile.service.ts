import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BusinessProfile } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PromptCacheService } from '../cache/prompt-cache.service';
import { ProfileCacheService } from '../cache/profile-cache.service';
import { SystemPromptCompilerService } from './system-prompt-compiler.service';
import { BusinessProfileDto } from '../common/types/business-profile.dto';

export interface UpsertResult {
  id: string;
  version: number;
  updated_at: Date;
}

@Injectable()
export class BusinessProfileService {
  private readonly logger = new Logger(BusinessProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptCache: PromptCacheService,
    private readonly profileCache: ProfileCacheService,
    private readonly compiler: SystemPromptCompilerService,
  ) {}

  async upsert(id: string, dto: BusinessProfileDto): Promise<UpsertResult> {
    const data = toPrismaInput(dto);

    const saved = await this.prisma.businessProfile.upsert({
      where: { id },
      create: { id, ...data, version: 1, active: true },
      update: {
        ...data,
        active: true,
        version: { increment: 1 },
      },
    });

    await Promise.all([
      this.promptCache.invalidate(id),
      this.profileCache.invalidate(id),
    ]);

    this.logger.log(`profile upserted id=${id} version=${saved.version}`);
    return { id: saved.id, version: saved.version, updated_at: saved.updated_at };
  }

  async get(id: string): Promise<BusinessProfile> {
    const cached = await this.profileCache.get<BusinessProfile>(id);
    if (cached) return cached;

    const row = await this.prisma.businessProfile.findUnique({ where: { id } });
    if (!row || !row.active) {
      throw new NotFoundException({ error: 'business_not_found', business_id: id });
    }
    await this.profileCache.set(id, row);
    return row;
  }

  async getCompiledPrompt(id: string): Promise<string> {
    const cached = await this.promptCache.get(id);
    if (cached) return cached;

    const profile = await this.get(id);
    const compiled = this.compiler.compile(asDto(profile));
    await this.promptCache.set(id, compiled);
    return compiled;
  }

  async softDelete(id: string): Promise<void> {
    const existing = await this.prisma.businessProfile.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: 'business_not_found', business_id: id });
    }
    await this.prisma.businessProfile.update({
      where: { id },
      data: { active: false },
    });
    await Promise.all([
      this.promptCache.invalidate(id),
      this.profileCache.invalidate(id),
    ]);
    this.logger.log(`profile soft-deleted id=${id}`);
  }
}

type ProfileWriteFields = Pick<
  Prisma.BusinessProfileUncheckedCreateInput,
  'name' | 'description' | 'language' | 'tone' | 'hours' | 'faqs' | 'policies' | 'escalation'
>;

function toPrismaInput(dto: BusinessProfileDto): ProfileWriteFields {
  return {
    name: dto.name,
    description: dto.description,
    language: dto.language,
    tone: dto.tone as unknown as Prisma.InputJsonValue,
    hours: dto.hours as unknown as Prisma.InputJsonValue,
    faqs: dto.faqs as unknown as Prisma.InputJsonValue,
    policies: dto.policies as unknown as Prisma.InputJsonValue,
    escalation: dto.escalation as unknown as Prisma.InputJsonValue,
  };
}

function asDto(row: BusinessProfile): BusinessProfileDto {
  return {
    name: row.name,
    description: row.description,
    language: row.language,
    tone: row.tone as unknown as BusinessProfileDto['tone'],
    hours: row.hours as unknown as BusinessProfileDto['hours'],
    faqs: row.faqs as unknown as BusinessProfileDto['faqs'],
    policies: row.policies as unknown as BusinessProfileDto['policies'],
    escalation: row.escalation as unknown as BusinessProfileDto['escalation'],
  };
}
