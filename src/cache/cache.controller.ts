import { Controller, Delete, Param, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { ProfileCacheService } from './profile-cache.service';
import { PromptCacheService } from './prompt-cache.service';

function compareTokens(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

@ApiTags('internal')
@Controller('internal/cache')
export class CacheController {
  constructor(
    private readonly config: AppConfigService,
    private readonly profileCache: ProfileCacheService,
    private readonly promptCache: PromptCacheService,
  ) {}

  /**
   * Called by main-backend after every profile or correction change.
   * Forces the next pipeline call to re-fetch the profile from main-backend
   * so corrections take effect immediately rather than waiting for TTL.
   *
   * Auth: Bearer <MAIN_BACKEND_INTERNAL_TOKEN>
   */
  @Delete('invalidate/:businessId')
  @ApiOperation({ summary: 'Invalidate profile + prompt cache for a tenant (internal)' })
  @ApiParam({ name: 'businessId', description: 'Tenant UUID' })
  async invalidate(@Param('businessId') businessId: string, @Req() req: Request) {
    const header = req.headers.authorization ?? '';
    const provided = header.replace(/^Bearer\s+/i, '').trim();
    const expected = this.config.mainBackendInternalToken();

    if (!provided || !expected || !compareTokens(provided, expected)) {
      throw new UnauthorizedException('Invalid internal token');
    }

    await Promise.all([
      this.profileCache.invalidate(businessId),
      this.promptCache.invalidate(businessId),
    ]);

    return { ok: true, businessId };
  }
}
