import { Injectable } from '@nestjs/common';
import type { BusinessProfile } from '@prisma/client';
import { BusinessProfileService } from '../business/business-profile.service';
import { AppConfigService } from '../config/app-config.service';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';
import type { ContextPacket, IncomingHistoryMessage } from '../common/types/pipeline.types';

export interface LoadArgs {
  business_id: string;
  history: IncomingHistoryMessage[];
  contact_id: string;
  channel: string;
  trace_id?: string;
}

@Injectable()
export class ContextLoaderService {
  constructor(
    private readonly profiles: BusinessProfileService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Single round-trip hydration of everything a pipeline turn needs.
   * - Profile (from cache → Postgres on miss).
   * - Compiled system prompt (from prompt cache → compile on miss).
   * - Trimmed history (last MAX_HISTORY_TURNS turns).
   * Throws NotFoundException if the business doesn't exist or has been deleted.
   */
  async load(args: LoadArgs): Promise<ContextPacket> {
    const profile = await this.profiles.get(args.business_id);
    const systemPrompt = await this.profiles.getCompiledPrompt(args.business_id);
    const maxTurns = this.config.maxHistoryTurns();

    return {
      business_id: args.business_id,
      profile: rowToDto(profile),
      systemPrompt,
      history: trimHistory(args.history, maxTurns),
      contact_id: args.contact_id,
      channel: args.channel,
      trace_id: args.trace_id,
    };
  }
}

function rowToDto(row: BusinessProfile): BusinessProfileDto {
  return {
    name: row.name,
    description: row.description,
    business_type: row.business_type ?? undefined,
    language: row.language,
    tone: row.tone as unknown as BusinessProfileDto['tone'],
    hours: row.hours as unknown as BusinessProfileDto['hours'],
    faqs: row.faqs as unknown as BusinessProfileDto['faqs'],
    policies: row.policies as unknown as BusinessProfileDto['policies'],
    escalation: row.escalation as unknown as BusinessProfileDto['escalation'],
    product_catalog:
      row.product_catalog === null
        ? undefined
        : (row.product_catalog as unknown as BusinessProfileDto['product_catalog']),
    locations:
      row.locations === null
        ? undefined
        : (row.locations as unknown as BusinessProfileDto['locations']),
    current_offers:
      row.current_offers === null
        ? undefined
        : (row.current_offers as unknown as BusinessProfileDto['current_offers']),
    high_value_threshold: row.high_value_threshold ?? undefined,
  };
}

function trimHistory(history: IncomingHistoryMessage[], maxTurns: number): IncomingHistoryMessage[] {
  if (!Array.isArray(history) || history.length <= maxTurns) return history ?? [];
  return history.slice(history.length - maxTurns);
}
