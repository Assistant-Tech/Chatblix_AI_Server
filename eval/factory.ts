import { OpenRouterClient } from '../src/pipeline/openrouter.client';
import { LLMClientService } from '../src/pipeline/llm-client.service';
import { PromptsService } from '../src/pipeline/prompts.service';
import { MetricsService } from '../src/pipeline/metrics.service';
import { TriageService } from '../src/pipeline/triage.service';
import { GeneratorService } from '../src/pipeline/generator.service';
import { ValidatorService } from '../src/pipeline/validator.service';
import { SystemPromptCompilerService } from '../src/business/system-prompt-compiler.service';

/**
 * Minimal config shim: the pipeline stages only call a handful of getters on
 * AppConfigService, so we satisfy them from env without booting Nest DI (mirrors
 * how the unit specs stub config). Keep defaults aligned with .env.example.
 */
function buildConfig() {
  const env = process.env;
  return {
    openrouterKey: () => env.OPENROUTER_API_KEY ?? '',
    triageModel: () => env.PIPELINE_TRIAGE_MODEL ?? 'anthropic/claude-haiku-4.5',
    generatorModel: () => env.PIPELINE_GENERATOR_MODEL ?? 'anthropic/claude-sonnet-4-6',
    validatorModel: () => env.PIPELINE_VALIDATOR_MODEL ?? 'anthropic/claude-haiku-4.5',
    triageTimeoutMs: () => Number(env.PIPELINE_TRIAGE_TIMEOUT_MS ?? 8000),
    generatorTimeoutMs: () => Number(env.PIPELINE_GENERATOR_TIMEOUT_MS ?? 20000),
    validatorTimeoutMs: () => Number(env.PIPELINE_VALIDATOR_TIMEOUT_MS ?? 8000),
    maxRetries: () => Number(env.PIPELINE_MAX_RETRIES ?? 1),
    maxHistoryTurns: () => Number(env.MAX_HISTORY_TURNS ?? 10),
    validateRiskyOnly: () => (env.PIPELINE_VALIDATE_RISKY_ONLY ?? 'false') === 'true',
  } as any;
}

export interface Stages {
  triage: TriageService;
  generator: GeneratorService;
  validator: ValidatorService;
  compiler: SystemPromptCompilerService;
  hasKey: boolean;
}

export function buildStages(): Stages {
  const config = buildConfig();
  const openRouter = new OpenRouterClient(config);
  const llm = new LLMClientService(openRouter);
  const prompts = new PromptsService();
  const metrics = new MetricsService();

  return {
    triage: new TriageService(config, llm, prompts, metrics),
    generator: new GeneratorService(config, llm, prompts, metrics),
    validator: new ValidatorService(config, llm, prompts, metrics),
    compiler: new SystemPromptCompilerService(),
    hasKey: Boolean(config.openrouterKey()),
  };
}
