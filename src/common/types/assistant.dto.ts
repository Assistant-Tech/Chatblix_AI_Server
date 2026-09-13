// ─── Digest assistant contract ────────────────────────────────────────────────
//
// Structural mirror of main-backend's `src/ai/types/ai-assistant.types.ts`.
// KEEP THE TWO IN SYNC — it is plain JSON on the wire, so a rename on one side
// silently becomes `undefined` on the other. The request is validated on arrival
// by `assistant/assistant-request.dto.ts` (class-validator).

import type { DigestStats, DigestWindow } from './digest.dto';

// ─── Request ──────────────────────────────────────────────────────────────────

export interface AssistantDigestContext {
  id: string;
  /** AiDigestStatus: READY | FAILED. */
  status: string;
  window: DigestWindow;
  summary: string;
  attentionItems: string[];
  stats: DigestStats;
}

export interface AssistantHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantStreamRequest {
  /** = tenantId, set by main-backend from the JWT. */
  business_id: string;
  business_name: string;
  language: string;
  /** ISO 8601. */
  now: string;
  digest: AssistantDigestContext;
  history: AssistantHistoryEntry[];
  message: { content: string };
  options: { trace_id: string; thread_id: string };
}

// ─── SSE frames ───────────────────────────────────────────────────────────────

export type AssistantStatusFrame = { type: 'thinking' } | { type: 'tool'; name: string; iteration: number } | { type: 'typing' };

export interface AssistantTokenFrame {
  content: string;
}

export interface AssistantRegenerateFrame {
  reason: 'tool_call';
}

/** Audit record of one tool call. Never the tool's result: results carry transcripts. */
export interface AssistantToolCallAudit {
  name: string;
  /** The arguments actually sent, after whitelisting and clamping. Null when they didn't parse. */
  arguments: Record<string, unknown> | null;
  ok: boolean;
  durationMs: number;
  resultChars: number;
  error: string | null;
}

export interface AssistantDoneFrame {
  answer: string;
  tool_calls: AssistantToolCallAudit[];
  iterations: number;
  capped: boolean;
  model: string;
  usage: { tokensIn: number | null; tokensOut: number | null; cachedIn: number | null };
  duration_ms: number;
  trace_id: string;
}

/** See the main-backend copy for what each code means. */
export type AssistantErrorCode = 'timeout' | 'provider_error' | 'budget_exceeded' | 'no_answer' | 'internal';

export interface AssistantErrorFrame {
  code: AssistantErrorCode;
  message: string;
}
