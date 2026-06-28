import type { ReplyResponse } from './reply.dto';

// Data collected during the pipeline run that main-backend writes to turn_logs table.
export interface AiTurnLogData {
  status: string;
  triage: object;
  attempts: object;
  validatorPass: boolean;
  // Whether the structured <metadata> (order/lead data) passed the validator's
  // metadata checks. Decoupled from validatorPass so order placement can depend
  // on data validity, not on reply-text style violations.
  metadataValid: boolean;
  retryCount: number;
  highSeverityViolations: number;
  intentPath: string | null;
  language: string | null;
  toolsCalled: string[];
  shipped: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  traceId: string | null;
  modelTriage: string | null;
  modelGenerator: string | null;
  modelValidator: string | null;
}

// Returned by the BullMQ worker as the job result.
// main-backend's AiHandoffService destructures this.
export interface AiReplyJobResult {
  response: ReplyResponse;
  turnLog: AiTurnLogData;
}
