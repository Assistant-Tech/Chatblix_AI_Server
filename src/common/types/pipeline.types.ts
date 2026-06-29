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
  sentiment?: string;
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

// Compact summary of an order already placed for this conversation. Set by
// main-backend so the generator knows an order exists and can stop re-confirming.
export interface ExistingOrderInfo {
  ref: string;
  status: string;
  paymentMethod?: string | null;
  total: number;
  items: Array<{ title: string; quantity: number }>;
}

// The single bag of data every pipeline stage receives.
// No service inside the pipeline should re-read DB / caches —
// ContextLoader is the only place that hydrates this.
export interface ContextPacket {
  business_id: string;
  profile: import('./business-profile.dto').BusinessProfileDto;
  history: IncomingHistoryMessage[];
  contact_id: string;
  // Present on the real reply path; absent in the sandbox (no real conversation).
  // Required for write tools like capture_lead that key off the conversation.
  conversation_id?: string;
  channel: string;
  trace_id?: string;
  systemPrompt?: string;
  // Present only when an order has already been placed for this conversation.
  existing_order?: ExistingOrderInfo;
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
  // Prompt tokens served from cache, and the billed-equivalent input
  // (uncached + cached×0.1). tokensIn stays the raw sum for backwards-compat.
  cachedIn: number | null;
  tokensInBilled: number | null;
  tools_called: string[];
}
