import { Module } from '@nestjs/common';
import { OpenRouterClient } from './openrouter.client';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { ResponseCleanerService } from './response-cleaner.service';
import { MetricsService } from './metrics.service';
import { TriageService } from './triage.service';
import { GeneratorService } from './generator.service';
import { ValidatorService } from './validator.service';
import { HoursService } from './hours.service';
import { EscalationRulesService } from './escalation-rules.service';
import { ToneCheckerService } from './tone-checker.service';
import { SafetyFilterService } from './safety-filter.service';
import { PipelineOrchestratorService } from './orchestrator.service';
import { ToolExecutorService } from './tool-executor.service';

const sharedProviders = [
  OpenRouterClient,
  LLMClientService,
  PromptsService,
  ResponseCleanerService,
  MetricsService,
  TriageService,
  GeneratorService,
  ValidatorService,
  HoursService,
  EscalationRulesService,
  ToneCheckerService,
  SafetyFilterService,
  ToolExecutorService,
  PipelineOrchestratorService,
];

@Module({
  providers: sharedProviders,
  exports: sharedProviders,
})
export class PipelineModule {}
