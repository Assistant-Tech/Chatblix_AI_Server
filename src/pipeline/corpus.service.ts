import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { highCount } from '../common/utils/pipeline/severity';
import type {
  PipelineAttempt,
  Triage,
} from '../common/types/pipeline.types';

export interface LogTurnInput {
  turn_id: string;
  session_id: string;
  ts: string | Date;
  duration_ms: number;
  input: Record<string, unknown>;
  triage: Triage;
  attempts: PipelineAttempt[];
  outcome: string;
  shipped: string;
}

@Injectable()
export class CorpusService {
  private readonly logger = new Logger(CorpusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async logTurn(turn: LogTurnInput): Promise<void> {
    if (!this.config.shouldLogCorpus()) return;

    const lastVerdict = turn.attempts?.[turn.attempts.length - 1]?.verdict;
    const violations = lastVerdict?.violations || [];

    await this.prisma.turnLog.create({
      data: {
        id: turn.turn_id,
        session_id: turn.session_id,
        ts: turn.ts ? new Date(turn.ts) : new Date(),
        duration_ms: Math.max(0, Math.round(turn.duration_ms || 0)),
        input: turn.input as object,
        triage: turn.triage as unknown as object,
        attempts: turn.attempts as unknown as object,
        outcome: turn.outcome,
        shipped: String(turn.shipped || ''),
        intent_path: turn.triage?.intent_path || null,
        language: turn.triage?.language?.detected || null,
        retry_count: Math.max(0, (turn.attempts?.length || 1) - 1),
        high_severity_violations: highCount(violations),
      },
    });
  }
}
