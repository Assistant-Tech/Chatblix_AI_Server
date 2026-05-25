import { Injectable, Logger } from '@nestjs/common';
import { BusinessProfileService } from '../business/business-profile.service';
import { SystemPromptCompilerService } from '../business/system-prompt-compiler.service';
import { PromptCacheService } from '../cache/prompt-cache.service';
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
  private readonly logger = new Logger(ContextLoaderService.name);

  constructor(
    private readonly profiles: BusinessProfileService,
    private readonly config: AppConfigService,
    private readonly compiler: SystemPromptCompilerService,
    private readonly promptCache: PromptCacheService,
  ) {}

  /**
   * Single round-trip hydration of everything a pipeline turn needs.
   * - Profile: Redis cache → main-backend HTTP on miss.
   * - System prompt: prompt cache → compiled on miss (24h TTL).
   * - History: trimmed to MAX_HISTORY_TURNS.
   * Throws NotFoundException if the business doesn't exist or AI is disabled.
   */
  async load(args: LoadArgs): Promise<ContextPacket> {
    const profile = await this.profiles.get(args.business_id);
    const maxTurns = this.config.maxHistoryTurns();
    const systemPrompt = await this.loadSystemPrompt(args.business_id, profile);

    return {
      business_id: args.business_id,
      profile,
      history: trimHistory(args.history, maxTurns),
      contact_id: args.contact_id,
      channel: args.channel,
      trace_id: args.trace_id,
      systemPrompt,
    };
  }

  private async loadSystemPrompt(businessId: string, profile: BusinessProfileDto): Promise<string> {
    try {
      const cached = await this.promptCache.get(businessId);
      if (cached) return cached;
      const compiled = this.compiler.compile(profile);
      await this.promptCache.set(businessId, compiled);
      return compiled;
    } catch (e) {
      this.logger.warn(`prompt cache error for ${businessId}: ${(e as Error).message} — compiling inline`);
      return this.compiler.compile(profile);
    }
  }
}

function trimHistory(history: IncomingHistoryMessage[], maxTurns: number): IncomingHistoryMessage[] {
  if (!Array.isArray(history) || history.length <= maxTurns) return history ?? [];
  return history.slice(history.length - maxTurns);
}
