import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

interface HealthResponse {
  status: 'ok';
  uptime_s: number;
  version: string;
}

const VERSION = process.env.npm_package_version || '0.1.0';
const BOOT_TIME_MS = Date.now();

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Liveness check.',
    description: 'Used by load balancers and the main backend circuit breaker. No auth.',
  })
  @ApiResponse({ status: 200, description: '{ status, uptime_s, version }' })
  health(): HealthResponse {
    return {
      status: 'ok',
      uptime_s: Math.floor((Date.now() - BOOT_TIME_MS) / 1000),
      version: VERSION,
    };
  }
}
