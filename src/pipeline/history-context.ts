import type { IncomingHistoryMessage } from '../common/types/pipeline.types';

export interface CompactHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Render conversation history for embedding in an LLM prompt, keeping only the
 * fields the models actually reason over: `role` and `content`.
 *
 * The raw `IncomingHistoryMessage` also carries `timestamp` and a `metadata`
 * blob (per-turn `extracted_data`, `lead_score`, etc.). That metadata is already
 * surfaced to the pipeline via `CUSTOMER_CONTEXT` (see `buildCustomerContext`),
 * so shipping it again inside `CONVERSATION_HISTORY` — in all three calls, up to
 * `MAX_HISTORY_TURNS` deep — is pure duplication in the *uncacheable* user
 * payload. Dropping `timestamp` + `metadata` is behavior-neutral for the models
 * and removes the heaviest part of the history JSON.
 */
export function compactHistory(
  history: IncomingHistoryMessage[] | null | undefined,
): CompactHistoryMessage[] {
  if (!Array.isArray(history)) return [];
  return history.map((m) => ({ role: m.role, content: m.content }));
}
