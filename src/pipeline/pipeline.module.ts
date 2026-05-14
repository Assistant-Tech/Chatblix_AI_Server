import { Module } from '@nestjs/common';
import { OpenRouterClient } from './openrouter.client';
import { PromptsService } from './prompts.service';
import { MetricsService } from './metrics.service';
import { TriageService } from './triage.service';
import { GeneratorService } from './generator.service';
import { ValidatorService } from './validator.service';
import { PipelineOrchestratorService } from './orchestrator.service';

@Module({
  providers: [
    OpenRouterClient,
    PromptsService,
    MetricsService,
    TriageService,
    GeneratorService,
    ValidatorService,
    PipelineOrchestratorService,
  ],
  exports: [
    OpenRouterClient,
    PromptsService,
    MetricsService,
    TriageService,
    GeneratorService,
    ValidatorService,
    PipelineOrchestratorService,
  ],
})
export class PipelineModule {}
