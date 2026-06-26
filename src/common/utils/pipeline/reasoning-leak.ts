/**
 * Detect chain-of-thought / meta-reasoning that leaked into a customer-facing
 * reply. The generator occasionally emits its thinking as plain content instead
 * of (or before) the real reply — most often after a failed tool call — and the
 * streaming prefix logic can wrap that thinking inside `<reply>` tags, so the
 * normal tag-based extraction doesn't catch it.
 *
 * High-confidence markers only: pipeline-internal tokens (JSON keys, stage names)
 * that must never appear in a real reply, plus distinctive multi-word English
 * meta-commentary. Single common words ("let me check") are deliberately excluded
 * to avoid flagging legitimate replies.
 */

// Pipeline-internal identifiers — these are metadata keys / stage labels and
// should never appear in customer prose.
const INTERNAL_TOKENS = [
  'order_confirmed',
  'missing_fields',
  'closing_state',
  'extracted_data',
  'lead_score',
  'payment_method"',
  'suggested_reply_language',
  'triage says',
  'triage json',
];

// Distinctive meta-commentary phrases (lowercased). Multi-word and specific so a
// normal reply ("let me check that for you") won't match.
const REASONING_PHRASES = [
  'let me re-read',
  'let me re read',
  'let me flag',
  'let me check the data',
  'let me check the metadata',
  'i need to check if',
  'i need to ask the customer',
  'i need to ask for the',
  'i should ask for',
  'i should confirm the',
  'looking at the data',
  'looking at the metadata',
  'based on the metadata',
  'before confirming the order',
  'the closing flow requires',
  'wait, let me',
  'wait let me',
];

export function looksLikeLeakedReasoning(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  for (const tok of INTERNAL_TOKENS) {
    if (t.includes(tok)) return true;
  }
  for (const phrase of REASONING_PHRASES) {
    if (t.includes(phrase)) return true;
  }
  return false;
}

/**
 * Extract the reply body from a shipped candidate for the leak check: the text
 * inside `<reply>...</reply>` when present, otherwise the candidate with tags and
 * any trailing `<metadata>` block stripped.
 */
export function replyBodyOf(shipped: string | null | undefined): string {
  if (!shipped) return '';
  const m = shipped.match(/<reply>([\s\S]*?)<\/reply>/i);
  const inner = m ? m[1] : shipped;
  return inner
    .replace(/<metadata>[\s\S]*$/i, '')
    .replace(/<\/?(reply|metadata)[^>]*>/gi, '')
    .trim();
}
