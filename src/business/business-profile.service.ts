import { Injectable, Logger } from '@nestjs/common';
import { PromptCacheService } from '../cache/prompt-cache.service';
import { ProfileCacheService } from '../cache/profile-cache.service';
import { SystemPromptCompilerService } from './system-prompt-compiler.service';
import { MainBackendClient } from '../common/clients/main-backend.client';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';

@Injectable()
export class BusinessProfileService {
  private readonly logger = new Logger(BusinessProfileService.name);

  constructor(
    private readonly promptCache: PromptCacheService,
    private readonly profileCache: ProfileCacheService,
    private readonly compiler: SystemPromptCompilerService,
    private readonly mainBackendClient: MainBackendClient,
  ) {}

  /**
   * Returns the BusinessProfile for a tenant.
   *
   * Cache hierarchy:
   *   1. Redis profile:{id}  — written by main-backend on every save (5min TTL)
   *   2. HTTP GET main-backend/internal/businesses/:id — cold cache fallback
   *      (hits only on Redis restart or first-ever request for this tenant)
   *
   * Throws NotFoundException if the profile doesn't exist or AI is disabled.
   */
  async get(id: string): Promise<BusinessProfileDto> {
    let cached: BusinessProfileDto | null = null;
    try {
      cached = await this.profileCache.get<BusinessProfileDto>(id);
    } catch (e) {
      this.logger.warn(
        `profile cache read error business_id=${id}: ${(e as Error).message} — falling back to main-backend`,
      );
    }
    if (cached) return cached;

    this.logger.log(`profile cache miss business_id=${id} — fetching from main-backend`);
    const profile = await this.mainBackendClient.getProfile(id);

    try {
      await this.profileCache.set(id, profile);
    } catch (e) {
      this.logger.warn(
        `profile cache write error business_id=${id}: ${(e as Error).message} — continuing without cache`,
      );
    }
    return profile;
  }

  /**
   * Returns a compiled per-tenant system prompt.
   * Cached as prompt:{id} (no TTL — invalidated by main-backend on profile save).
   *
   * Note: Not yet wired into pipeline LLM calls (tracked as Task 2.2a).
   * Pipeline stages currently use static markdown prompts via PromptsService.
   */
  async getCompiledPrompt(id: string): Promise<string> {
    const cached = await this.promptCache.get(id);
    if (cached) return cached;

    const profile = await this.get(id);
    const compiled = this.compiler.compile(profile);
    await this.promptCache.set(id, compiled);
    return compiled;
  }
}
