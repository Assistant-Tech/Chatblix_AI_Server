import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantOrchestratorService } from './assistant-orchestrator.service';
import { AssistantToolExecutorService } from './assistant-tool-executor.service';

/**
 * The owner-facing digest assistant. Needs only the pipeline's LLM client,
 * prompts and metrics — no BusinessModule, no profile cache: everything it
 * knows about the business arrives in the request or through its own tools.
 */
@Module({
  imports: [PipelineModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantOrchestratorService, AssistantToolExecutorService],
})
export class AssistantModule {}
