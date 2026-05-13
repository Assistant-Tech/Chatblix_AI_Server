import type { HistoryMessage, LanguageCode } from '../../types/pipeline.types';
import { detectLanguage } from '../language-detector';

export function derivePriorAssistantLang(history: HistoryMessage[]): LanguageCode | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const text = String(m.content || '');
    const lang = detectLanguage(text);
    if (lang === 'ne_devanagari' || lang === 'romanized_ne' || lang === 'mixed') return 'romanized_ne';
    if (lang === 'en') return 'en';
  }
  return null;
}

export function derivePriorAgentQuestion(history: HistoryMessage[]): string | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const text = String(m.content || '').trim();
    if (!text) continue;
    const matches = text.match(/[^?.!]*\?[^?.!]*$/);
    if (matches && matches[0]) return matches[0].trim();
    return text.slice(-200);
  }
  return null;
}

const STALLED_KEY = '_stalled_count';

export function readStalledCount(extractedData: Record<string, unknown> | null | undefined): number {
  if (!extractedData || typeof extractedData !== 'object') return 0;
  const v = Number((extractedData as Record<string, unknown>)[STALLED_KEY]);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

export const PIPELINE_BOOKKEEPING_KEYS = new Set<string>([
  '_stalled_count',
  '_last_agent_question',
  '_last_agent_lang',
]);

export function stripBookkeeping(extractedData: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!extractedData || typeof extractedData !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extractedData)) {
    if (PIPELINE_BOOKKEEPING_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
