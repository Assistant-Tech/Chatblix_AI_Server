import { Module } from '@nestjs/common';
import { OpenRouterClient } from './openrouter.client';
import { LLMClientService } from './llm-client.service';
import { PromptsService } from './prompts.service';
import { PromptAssemblerService } from './prompt-assembler.service';
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

const sharedProviders = [
  OpenRouterClient,
  LLMClientService,
  PromptsService,
  PromptAssemblerService,
  ResponseCleanerService,
  MetricsService,
  TriageService,
  GeneratorService,
  ValidatorService,
  HoursService,
  EscalationRulesService,
  ToneCheckerService,
  SafetyFilterService,
  PipelineOrchestratorService,
];

@Module({
  providers: sharedProviders,
  exports: sharedProviders,
})
export class PipelineModule {}
