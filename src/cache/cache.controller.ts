import { Controller, Delete, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { ProfileCacheService } from './profile-cache.service';
import { PromptCacheService } from './prompt-cache.service';

@ApiTags('internal')
@Controller('internal/cache')
export class CacheController {
  constructor(
    private readonly profileCache: ProfileCacheService,
    private readonly promptCache: PromptCacheService,
  ) {}

  /**
   * Called by main-backend after every profile or correction change.
   * Forces the next pipeline call to re-fetch the profile from main-backend
   * so corrections take effect immediately rather than waiting for TTL.
   *
   * Auth: the global InternalTokenGuard (APP_GUARD) enforces the Bearer
   * <MAIN_BACKEND_INTERNAL_TOKEN> — no per-handler token check is needed here.
   */
  @Delete('invalidate/:businessId')
  @ApiOperation({ summary: 'Invalidate profile + prompt cache for a tenant (internal)' })
  @ApiParam({ name: 'businessId', description: 'Tenant UUID' })
  async invalidate(@Param('businessId') businessId: string) {
    await Promise.all([
      this.profileCache.invalidate(businessId),
      this.promptCache.invalidate(businessId),
    ]);

    return { ok: true, businessId };
  }
}
