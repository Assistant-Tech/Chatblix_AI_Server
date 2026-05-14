import { Injectable } from '@nestjs/common';
import type { ContextPacket, Triage } from '../common/types/pipeline.types';

export interface AssembledPrompt {
  system: string;
  user: string;
}

export interface FailureHint {
  previous_attempt: string;
  reasons: string[];
}

const MAX_HISTORY_TURNS_DEFAULT = 10;

@Injectable()
export class PromptAssemblerService {
  /**
   * Builds the (system, user) pair the LLM clients consume. The system half
   * is the per-business compiled prompt from `ctx.systemPrompt`. The user
   * half packs LATEST_MESSAGE + (recent) CONVERSATION_HISTORY + BUSINESS_CONTEXT
   * + TRIAGE + optional FEEDBACK so the model has all grounded inputs in one
   * place.
   *
   * Stage instructions (triage/generator/validator-specific) are still loaded
   * separately by each service via PromptsService until Task 2.2a lands.
   */
  assemble(args: {
    ctx: ContextPacket;
    currentMessage: string;
    triage?: Triage | null;
    failureHint?: FailureHint | null;
    maxHistoryTurns?: number;
  }): AssembledPrompt {
    const { ctx, currentMessage, triage, failureHint } = args;
    const maxTurns = args.maxHistoryTurns ?? MAX_HISTORY_TURNS_DEFAULT;
    const trimmedHistory = trimHistory(ctx.history, maxTurns);

    const parts = [
      `LATEST_MESSAGE: ${currentMessage}`,
      `CONVERSATION_HISTORY: ${JSON.stringify(trimmedHistory)}`,
      `BUSINESS_CONTEXT: ${JSON.stringify(ctx.profile)}`,
    ];
    if (triage) parts.push(`TRIAGE: ${JSON.stringify(triage)}`);
    if (failureHint) parts.push(`FEEDBACK: ${JSON.stringify(failureHint)}`);

    return {
      system: ctx.systemPrompt,
      user: parts.join('\n\n'),
    };
  }
}

function trimHistory<T>(history: T[], maxTurns: number): T[] {
  if (!Array.isArray(history) || history.length <= maxTurns) return history ?? [];
  return history.slice(history.length - maxTurns);
}
