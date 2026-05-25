import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import type { BusinessProfileDto } from '../types/business-profile.dto';

const TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class MainBackendClient {
  private readonly logger = new Logger(MainBackendClient.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * Fetches the BusinessProfile from main-backend.
   * Called ONLY on Redis cache miss (cold start or Redis eviction).
   *
   * main-backend endpoint: GET /api/v1/internal/businesses/:tenantId
   * Auth: Bearer MAIN_BACKEND_INTERNAL_TOKEN
   *
   * Returns 404 if the profile doesn't exist or AI is disabled for the tenant.
   * Retries up to MAX_RETRIES times on transient network/5xx errors (not 404).
   */
  async getProfile(tenantId: string): Promise<BusinessProfileDto> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.fetchProfile(tenantId);
      } catch (e) {
        if (e instanceof NotFoundException) throw e;
        lastError = e;
        if (attempt < MAX_RETRIES) {
          this.logger.warn(
            `main-backend fetch attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for business_id=${tenantId} — retrying in ${RETRY_DELAY_MS}ms`,
          );
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }

  private async fetchProfile(tenantId: string): Promise<BusinessProfileDto> {
    const url = `${this.config.mainBackendInternalUrl()}/api/v1/internal/businesses/${tenantId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.mainBackendInternalToken()}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        throw new InternalServerErrorException(`main-backend request timed out after ${TIMEOUT_MS}ms`);
      }
      throw new InternalServerErrorException(`main-backend request failed: ${err?.message ?? String(e)}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw new NotFoundException({ error: 'business_not_found', business_id: tenantId });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`main-backend returned ${response.status} for business_id=${tenantId}: ${body.slice(0, 200)}`);
      throw new InternalServerErrorException(`main-backend returned ${response.status}`);
    }

    const json = await response.json() as { data?: BusinessProfileDto } | BusinessProfileDto;

    // main-backend wraps responses in { data: ... } via ResponseInterceptor
    const profile = 'data' in json && json.data ? json.data : json as BusinessProfileDto;

    return profile;
  }
}
