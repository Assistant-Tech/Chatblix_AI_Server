export type LanguageCode = 'romanized_ne' | 'en' | 'mixed';

export interface TriageLanguage {
  detected: LanguageCode;
  inheritance_used: boolean;
  markers_found: string[];
  language_inheritance_reason?: string | null;
}

export interface TriageClosingState {
  in_closing: boolean;
  stage: string | null;
  stage_1_already_fired: boolean;
  missing_fields: string[];
}

export interface Triage {
  language: TriageLanguage;
  intent_path: string;
  concern: string | null;
  named_product: string | null;
  extracted_data_delta: Record<string, string | null>;
  closing_state: TriageClosingState;
  buying_signal: boolean;
  explicit_price_ask?: boolean;
  process_question_topic?: string | null;
  edge_case_flags?: string[];
  handoff_required: boolean;
  handoff_reason?: string | null;
  stalled_count?: number;
  notes_for_generator?: string | null;
  _synthesized?: boolean;
  [key: string]: unknown;
}

export type ViolationSeverity = 'high' | 'medium' | 'low';

export interface Violation {
  rule_id: number;
  rule_name: string;
  severity: ViolationSeverity;
  evidence: string;
  fix_hint: string;
}

export interface Verdict {
  pass: boolean;
  violations: Violation[];
  metadata_valid?: boolean;
  language_match?: boolean;
  summary?: string;
  _soft_pass?: boolean;
}

export interface AgentMetadata {
  lead_score?: number;
  stage?: string;
  intent?: string;
  next_step?: string;
  next_action?: string;
  extracted_data?: Record<string, unknown>;
  handoff_required?: boolean;
  handoff_context?: string | null;
  suggested_reply_language?: LanguageCode;
  tags?: string[];
  last_signal?: string;
  score_delta?: number;
  [key: string]: unknown;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown> | null;
  timestamp?: Date;
}

// Wire-shape history message — as it arrives in the job payload.
export interface IncomingHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// The single bag of data every pipeline stage receives.
// No service inside the pipeline should re-read DB / caches —
// ContextLoader is the only place that hydrates this.
export interface ContextPacket {
  business_id: string;
  profile: import('./business-profile.dto').BusinessProfileDto;
  history: IncomingHistoryMessage[];
  contact_id: string;
  channel: string;
  trace_id?: string;
}

export type PipelineEventName =
  | 'metadata'
  | 'triage'
  | 'token'
  | 'regenerate'
  | 'verdict'
  | 'escalate'
  | 'outside_hours'
  | 'done'
  | 'error'
  | '_done_internal';

export interface PipelineEvent<T = unknown> {
  event: PipelineEventName | string;
  data: T;
}

export interface PipelineAttempt {
  attempt_idx: number;
  candidate: string;
  verdict: Verdict;
}

export interface StreamTurnInput {
  ctx: ContextPacket;
  message: string;
  customerContext: Record<string, unknown>;
  priorAssistantLang: LanguageCode | null;
  priorAgentQuestion: string | null;
  stalledCountIncoming: number;
}

export interface DoneInternalData {
  turn_id: string;
  shipped: string;
  outcome: string;
  triage: Triage;
  attempts: PipelineAttempt[];
  lastEmittedReplyLen: number;
  escalated?: { reason: string; matched_trigger?: string };
  duration_ms: number;
  tokensIn: number | null;
  tokensOut: number | null;
}
