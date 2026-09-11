// ─── ai.digest job contracts ──────────────────────────────────────────────────
//
// Structural mirror of main-backend's `src/ai/jobs/ai-digest.job.ts`. Keep the
// two in sync — BullMQ carries plain JSON, so a rename on one side silently
// becomes `undefined` on the other.
//
// The payload is aggregated counters only. No message content, no transcripts:
// the digest narrates numbers, so sending conversation text would cost tokens
// and expose customer data for nothing.

export interface DigestWindow {
  /** ISO 8601, inclusive. */
  start: string;
  /** ISO 8601, exclusive. */
  end: string;
  /** Window length in hours, one decimal. */
  hours: number;
}

export interface DigestChannelVolume {
  channel: string;
  inbound: number;
  outbound: number;
  conversations: number;
}

export interface DigestStuckConversation {
  conversationId: string;
  /** Conversation title (contact name) — never message content. */
  title: string;
  channel: string;
  waitingMinutes: number;
  /** Operator-facing handoff explanation, or the pause category. */
  reason: string | null;
}

export interface DigestStats {
  window: DigestWindow;
  conversations: {
    active: number;
    created: number;
    resolved: number;
  };
  handling: {
    aiHandled: number;
    humanHandled: number;
    aiReplies: number;
    escalations: number;
    handoffs: number;
  };
  channels: DigestChannelVolume[];
  captured: {
    leads: number;
    orders: number;
    orderValue: number;
  };
  backlog: {
    unassignedOverThreshold: number;
    unassignedThresholdMinutes: number;
    oldestUnresolvedHandoffMinutes: number | null;
    pending: number;
    stuck: DigestStuckConversation[];
  };
}

export interface DigestRequestDto {
  business_id: string;
  business_name: string;
  /** Profile language ('en' | 'romanized_ne' | 'mixed'); the digest is written in it. */
  language: string;
  window: DigestWindow;
  stats: DigestStats;
  options?: {
    trace_id?: string;
    request_id?: string;
  };
}

/**
 * Returned by AiDigestWorker as the BullMQ job result. Structured rather than
 * free-form so main-backend renders it consistently instead of parsing prose —
 * the same reason AiReplyJobResult splits `response` from `turnLog`.
 */
export interface AiDigestJobResult {
  summary: string;
  attentionItems: string[];
  meta: {
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number;
    traceId: string | null;
    /** True when the LLM produced nothing usable and the stats-only fallback was shipped. */
    fallbackUsed: boolean;
  };
}

/**
 * Minimal shape check on the job payload. A payload missing these can never
 * succeed on a retry, so the worker turns a false here into an
 * UnrecoverableError instead of burning the retry budget.
 */
export function isDigestRequest(value: unknown): value is DigestRequestDto {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.business_id !== 'string' || !v.business_id) return false;
  if (!v.window || typeof v.window !== 'object') return false;
  const w = v.window as Record<string, unknown>;
  if (typeof w.start !== 'string' || typeof w.end !== 'string') return false;
  if (!v.stats || typeof v.stats !== 'object') return false;
  const s = v.stats as Record<string, unknown>;
  return Boolean(s.conversations && s.handling && s.backlog);
}
