import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../pipeline/metrics.service';
import { HealthResponseDto, PipelineHealthResponseDto } from '../common/types/chat.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness + configuration check',
    description: 'Returns 200 with current model + KB config when `OPENROUTER_API_KEY` is set, 502 otherwise.',
  })
  @ApiResponse({ status: 200, description: 'Service ready.', type: HealthResponseDto })
  @ApiResponse({ status: 502, description: '`OPENROUTER_API_KEY` is not configured.' })
  health(): HealthResponseDto {
    if (!this.config.openrouterKey()) {
      throw new HttpException(
        { ok: false, error: 'OPENROUTER_API_KEY not set' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return {
      ok: true,
      model: this.config.legacyModel(),
      kb_file: this.config.kbFile(),
      provider: 'openrouter',
      pipeline_enabled: this.config.isPipelineEnabled(),
    };
  }

  @Get('pipeline')
  @ApiOperation({
    summary: 'Pipeline configuration + in-process metrics snapshot',
    description:
      'Returns the stage models currently in use and counters since boot (total_turns, pass/retry/ship breakdowns, validator soft-pass count, violations_by_rule). For persistent aggregation query the `TurnLog` table directly.',
  })
  @ApiResponse({ status: 200, description: 'Pipeline snapshot.', type: PipelineHealthResponseDto })
  pipeline(): PipelineHealthResponseDto {
    return {
      enabled: this.config.isPipelineEnabled(),
      models: {
        triage: this.config.triageModel(),
        generator: this.config.generatorModel(),
        validator: this.config.validatorModel(),
      },
      counters: this.metrics.snapshot() as unknown as Record<string, unknown>,
    };
  }
}
