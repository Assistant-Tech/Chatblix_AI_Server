import type { Triage, Verdict } from '../../types/pipeline.types';

export const TRIAGE_INTENT_PATHS = new Set<string>([
  'greeting',
  'direct_factual',
  'concern',
  'named_product_no_price',
  'named_product_price_ask',
  'buying_signal',
  'process_question',
  'complaint',
  'reasking',
  'bargain',
  'modify_order',
  'invoice_request',
  'confusion',
  'stalled',
  'abusive',
  'meta_question',
  'bulk_inquiry',
  'gift_purchase',
  'combo_request',
  'authenticity_check',
  'reorder',
  'discovery_open',
  'scheduling_request',
  'samples_request',
  'medical_mention',
  'evaluation_question',
]);

export const TRIAGE_LANGUAGES = new Set<string>(['romanized_ne', 'en', 'mixed']);

export function isTriageShape(t: unknown): t is Triage {
  if (!t || typeof t !== 'object') return false;
  const obj = t as Record<string, unknown>;
  if (!obj.language || typeof obj.language !== 'object') return false;
  const lang = obj.language as Record<string, unknown>;
  if (typeof lang.detected !== 'string' || !TRIAGE_LANGUAGES.has(lang.detected)) return false;
  if (typeof obj.intent_path !== 'string' || !TRIAGE_INTENT_PATHS.has(obj.intent_path)) return false;
  if (!obj.extracted_data_delta || typeof obj.extracted_data_delta !== 'object') return false;
  if (!obj.closing_state || typeof obj.closing_state !== 'object') return false;
  if (typeof obj.buying_signal !== 'boolean') return false;
  if (typeof obj.handoff_required !== 'boolean') return false;
  return true;
}

export function isVerdictShape(v: unknown): v is Verdict {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.pass !== 'boolean') return false;
  if (!Array.isArray(obj.violations)) return false;
  return true;
}

export function extractJsonObject(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  let cleaned = raw.trim();

  if (cleaned.startsWith('```')) {
    const firstFenceEnd = cleaned.indexOf('\n');
    if (firstFenceEnd >= 0) cleaned = cleaned.slice(firstFenceEnd + 1);
    const lastFence = cleaned.lastIndexOf('```');
    if (lastFence >= 0) cleaned = cleaned.slice(0, lastFence);
    cleaned = cleaned.trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to balanced-brace scan.
  }

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}
