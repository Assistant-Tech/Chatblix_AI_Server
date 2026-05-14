import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { InternalService } from './internal.service';

@ApiTags('internal')
@Controller('internal')
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  @Get('turns')
  @ApiOperation({
    summary: 'Paginated TurnLog rows. AI-team observability only — NOT for tenants.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO 8601 lower bound on ts (defaults to now - 24h)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO 8601 upper bound on ts (defaults to now)' })
  @ApiQuery({ name: 'business_id', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 100, max 500' })
  @ApiResponse({ status: 200, description: 'TurnLog[]' })
  async turns(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('business_id') business_id?: string,
    @Query('limit') limit?: string,
  ) {
    return this.internal.listTurns({
      from,
      to,
      business_id,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('stats/p95-latency')
  @ApiOperation({ summary: 'p50 / p95 / p99 of duration_ms over the window. Default window: last 24h.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'business_id', required: false })
  async latency(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('business_id') business_id?: string,
  ) {
    return this.internal.latencyStats({ from, to, business_id });
  }

  @Get('stats/escalation-rate')
  @ApiOperation({ summary: 'Fraction of turns with status=escalate over the window.' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'business_id', required: false })
  async escalation(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('business_id') business_id?: string,
  ) {
    return this.internal.escalationRate({ from, to, business_id });
  }

  @Get('stats/validator-pass-rate')
  @ApiOperation({ summary: 'Fraction of turns where validator_pass=true (first-try OR after retry).' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'business_id', required: false })
  async validatorPass(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('business_id') business_id?: string,
  ) {
    return this.internal.validatorPassRate({ from, to, business_id });
  }
}
