import { extractJsonObject } from './pipeline/contracts';
import type { AgentMetadata } from '../types/pipeline.types';

const FALLBACK_METADATA: Required<Pick<AgentMetadata,
  'lead_score' | 'stage' | 'intent' | 'next_step' | 'extracted_data' | 'handoff_required' | 'handoff_context' | 'suggested_reply_language' | 'tags'
>> = {
  lead_score: 0,
  stage: 'cold',
  intent: 'browsing',
  next_step: 'Monitor conversation',
  extracted_data: {},
  handoff_required: false,
  handoff_context: null,
  suggested_reply_language: 'en',
  tags: [],
};

const FALLBACK_REPLIES_EN = {
  bot_check: "You're with our support team. How can I help you today?",
  complaint: 'I understand your concern. A colleague will follow up shortly to resolve this.',
  unknown: "Could you share a bit more about what you're looking for?",
  error: 'Could you rephrase your question?',
  handoff: 'One moment, a colleague will pick this up shortly.',
};

const FALLBACK_REPLIES_NE = {
  bot_check: 'Hajur, hamro support team sanga hunuhunchha. K sahayog garum?',
  complaint: 'Bujhna sakichha hajur. Hamro team le shortly follow up garchha.',
  unknown: 'Hajur, ali detail bhanidinu hola, k khojeko?',
  error: 'Hajur, pheri ek pak bhanidinu hola.',
  handoff: 'Hajur, ek minute ma colleague le respond garchha.',
};

type FallbackSet = typeof FALLBACK_REPLIES_EN;

function pickFallbackSet(userMessage: string): FallbackSet {
  if (!userMessage || typeof userMessage !== 'string') return FALLBACK_REPLIES_EN;
  const lower = userMessage.toLowerCase();
  if (/[ऀ-ॿ]/.test(userMessage)) return FALLBACK_REPLIES_NE;
  const NE_HINTS = /\b(hajur|namaste|cha|chha|xa|ho|hoina|kati|kasto|kaha|malai|tapai|tapailai|garna|garne|garchu|milcha|huncha|hunchha|lagcha|ko|ma|lai|le|bata|pani|matra|hola|khojeko|bhanidinu|bhanidinus|vako|vanna|taha|xaina|chhaina)\b/;
  if (NE_HINTS.test(lower)) return FALLBACK_REPLIES_NE;
  return FALLBACK_REPLIES_EN;
}

const BOT_CHECK_PATTERNS = /are you (a bot|ai|robot|human|real)|is this (a bot|ai|automated)/i;
const COMPLAINT_PATTERNS = /complain|not working|broken|refund|wrong order|late delivery|damaged|issue|problem|bad experience/i;

export interface ParseResult {
  reply: string;
  metadata: AgentMetadata;
}

export function parseAgentOutput(raw: string, userMessage: string = ''): ParseResult {
  const FALLBACK_REPLIES = pickFallbackSet(userMessage);

  if (BOT_CHECK_PATTERNS.test(userMessage)) {
    return {
      reply: FALLBACK_REPLIES.bot_check,
      metadata: { ...FALLBACK_METADATA, intent: 'inquiry', tags: ['bot-check'] },
    };
  }

  const isComplaint = COMPLAINT_PATTERNS.test(userMessage);

  // Unwrap markdown code fences — some models wrap the entire output in ```...```
  // despite the prompt explicitly forbidding it (e.g. Gemma, smaller Haiku variants).
  raw = raw.replace(/```(?:[^\n]*)?\n([\s\S]*?)```/g, '$1');
  raw = raw.replace(/`{3}[^\n]*/g, '');

  // Collapse double <reply> tags (may be adjacent or separated by a code fence opener).
  raw = raw.replace(/<reply>\s*<reply>/gi, '<reply>');

  const replyMatch = raw.match(/<reply>([\s\S]*?)<\/reply>/i);
  const metaMatch = raw.match(/<metadata>([\s\S]*?)<\/metadata>/i);

  let metadata: AgentMetadata | null = null;
  if (metaMatch) {
    try {
      metadata = JSON.parse(metaMatch[1].trim());
    } catch {
      const salvaged = extractJsonObject(metaMatch[1]);
      metadata = (salvaged as AgentMetadata | null) ?? null;
    }
  } else {
    const salvaged = extractJsonObject(raw) as AgentMetadata | null;
    if (salvaged && (salvaged.lead_score !== undefined || salvaged.stage)) {
      metadata = salvaged;
    }
  }

  const enforced = enforceMetadataSchema(metadata, isComplaint);

  let reply: string;
  if (replyMatch) {
    // Strip any nested <reply> tags that survived deduplication
    const inner = replyMatch[1].trim().replace(/<\/?reply>/gi, '').trim();
    reply = sanitizeReplyText(inner);
  } else {
    const openIdx = raw.search(/<reply>/i);
    if (openIdx >= 0) {
      const after = raw.slice(openIdx + 7);
      const cleaned = stripNoise(after);
      reply = cleaned || (isComplaint ? FALLBACK_REPLIES.complaint : FALLBACK_REPLIES.unknown);
    } else {
      const cleaned = stripNoise(raw);
      reply = cleaned || (isComplaint ? FALLBACK_REPLIES.complaint : FALLBACK_REPLIES.unknown);
    }
  }

  if (!reply || reply.length < 2) {
    reply = isComplaint ? FALLBACK_REPLIES.complaint : FALLBACK_REPLIES.error;
  }

  if (isComplaint) {
    enforced.handoff_required = true;
    enforced.intent = 'complaint';
    enforced.tags = [...new Set([...(enforced.tags ?? []), 'escalation'])];
  }

  return { reply, metadata: enforced };
}

function enforceMetadataSchema(raw: AgentMetadata | null, isComplaint = false): AgentMetadata {
  if (!raw || typeof raw !== 'object') return { ...FALLBACK_METADATA };

  return {
    lead_score: raw.lead_score !== undefined ? clampScore(raw.lead_score) : undefined,
    stage: raw.stage !== undefined ? validateStage(raw.stage) : undefined,
    intent: validateIntent(raw.intent),
    next_step:
      typeof raw.next_step === 'string'
        ? raw.next_step
        : typeof raw.next_action === 'string'
          ? raw.next_action
          : FALLBACK_METADATA.next_step,
    extracted_data:
      raw.extracted_data && typeof raw.extracted_data === 'object'
        ? raw.extracted_data
        : {},
    handoff_required: Boolean(raw.handoff_required ?? isComplaint),
    handoff_context: raw.handoff_context ?? null,
    suggested_reply_language: (raw.suggested_reply_language ?? 'en') as AgentMetadata['suggested_reply_language'],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  };
}

function clampScore(score: unknown): number {
  const n = Number(score);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function validateStage(stage: unknown): string {
  const valid = ['cold', 'warm', 'hot', 'closing', 'lost'];
  return typeof stage === 'string' && valid.includes(stage) ? stage : 'cold';
}

function validateIntent(intent: unknown): string {
  const valid = ['buying', 'inquiry', 'complaint', 'browsing'];
  return typeof intent === 'string' && valid.includes(intent) ? intent : 'browsing';
}

function sanitizeReplyText(s: string): string {
  if (!s) return s;
  return s
    .replace(/\s*—\s*/g, ', ')
    .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
    .replace(/\s*–\s*/g, ', ')
    .replace(/[ \t]+([,.;!?])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/[ \t]{2,}/g, ' ');
}

function stripNoise(s: string): string {
  const cleaned = s
    .replace(/<execute_tool>[\s\S]*?<\/execute_tool>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, '')
    .replace(/<metadata>[\s\S]*?<\/metadata>/gi, '')
    .replace(/<metadata>[\s\S]*$/gi, '')
    .replace(/<\/?reply>/gi, '')
    .replace(/```[\s\S]*?```/gi, '')
    .trim();
  return sanitizeReplyText(cleaned);
}

function stripStreamingNoise(s: string): string {
  const cleaned = s
    .replace(/<execute_tool>[\s\S]*?(?:<\/execute_tool>|$)/gi, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
    .replace(/<function_call>[\s\S]*?(?:<\/function_call>|$)/gi, '')
    .replace(/<metadata>[\s\S]*?(?:<\/metadata>|$)/gi, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/<\/?reply>/gi, '')
    .replace(/<\/?[a-z][a-z0-9_]*$/i, '')
    .trim();
  return sanitizeReplyText(cleaned);
}

export interface PartialParseResult {
  reply: string;
  metadata: AgentMetadata;
  replyComplete: boolean;
}

export function parsePartialAgentOutput(buffer: string, userMessage: string = ''): PartialParseResult {
  const FALLBACK_REPLIES = pickFallbackSet(userMessage);
  if (BOT_CHECK_PATTERNS.test(userMessage)) {
    return {
      reply: FALLBACK_REPLIES.bot_check,
      metadata: { intent: 'inquiry', tags: ['bot-check'] },
      replyComplete: true,
    };
  }

  const isComplaint = COMPLAINT_PATTERNS.test(userMessage);

  let reply = '';
  let replyComplete = false;
  const replyOpen = buffer.search(/<reply>/i);
  if (replyOpen >= 0) {
    const afterOpen = buffer.slice(replyOpen + 7);
    const closeIdx = afterOpen.search(/<\/reply>/i);
    if (closeIdx >= 0) {
      reply = stripStreamingNoise(afterOpen.slice(0, closeIdx));
      replyComplete = true;
    } else {
      reply = stripStreamingNoise(afterOpen);
    }
  } else {
    reply = '';
  }

  const metadata: AgentMetadata = {};
  const metaOpen = buffer.search(/<metadata>/i);
  let metaSrc = '';
  if (metaOpen >= 0) {
    metaSrc = buffer.slice(metaOpen + 10);
    const metaClose = metaSrc.search(/<\/metadata>/i);
    if (metaClose >= 0) metaSrc = metaSrc.slice(0, metaClose);
  }

  if (metaSrc) {
    const complete = extractJsonObject(metaSrc);
    if (complete && typeof complete === 'object') {
      Object.assign(metadata, complete);
    } else {
      assignIfMatch(metadata, 'lead_score', metaSrc, /"lead_score"\s*:\s*(-?\d+(?:\.\d+)?)/, (v) => clampScore(v));
      assignIfMatch(metadata, 'stage', metaSrc, /"stage"\s*:\s*"([^"\\]*)"/, (v) => v);
      assignIfMatch(metadata, 'intent', metaSrc, /"intent"\s*:\s*"([^"\\]*)"/, (v) => v);
      assignIfMatch(metadata, 'next_step', metaSrc, /"next_step"\s*:\s*"((?:[^"\\]|\\.)*)"/, (v) => v);
      assignIfMatch(metadata, 'next_action', metaSrc, /"next_action"\s*:\s*"((?:[^"\\]|\\.)*)"/, (v) => v);
      assignIfMatch(metadata, 'suggested_reply_language', metaSrc, /"suggested_reply_language"\s*:\s*"([^"\\]*)"/, (v) => v);
      assignIfMatch(metadata, 'handoff_required', metaSrc, /"handoff_required"\s*:\s*(true|false)/, (v) => v === 'true');
      assignIfMatch(metadata, 'handoff_context', metaSrc, /"handoff_context"\s*:\s*"((?:[^"\\]|\\.)*)"/, (v) => v);

      const tagsMatch = metaSrc.match(/"tags"\s*:\s*\[([^\]]*)\]/);
      if (tagsMatch) {
        const tags = [...tagsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
        if (tags.length > 0) metadata.tags = tags;
      }

      const edStart = metaSrc.search(/"extracted_data"\s*:\s*\{/);
      if (edStart >= 0) {
        const objStart = metaSrc.indexOf('{', edStart + 16);
        if (objStart >= 0) {
          const ed = sliceBalancedObject(metaSrc, objStart);
          if (ed.complete) {
            try {
              metadata.extracted_data = JSON.parse(ed.text);
            } catch {
              // ignore
            }
          } else {
            const partial: Record<string, unknown> = {};
            for (const m of ed.text.matchAll(/"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)) {
              partial[m[1]] = m[2];
            }
            for (const m of ed.text.matchAll(/"([a-z_]+)"\s*:\s*(-?\d+(?:\.\d+)?)/gi)) {
              if (!(m[1] in partial)) partial[m[1]] = Number(m[2]);
            }
            if (Object.keys(partial).length > 0) metadata.extracted_data = partial;
          }
        }
      }
    }
  }

  if (metadata.stage !== undefined) metadata.stage = validateStage(metadata.stage);
  if (metadata.intent !== undefined) metadata.intent = validateIntent(metadata.intent);
  if (isComplaint) metadata.handoff_required = true;

  if (!reply || reply.length < 2) {
    reply = '';
  }

  return { reply, metadata, replyComplete };
}

function assignIfMatch<T>(
  target: Record<string, unknown>,
  key: string,
  src: string,
  re: RegExp,
  transform: (v: string) => T,
): void {
  const m = src.match(re);
  if (m) target[key] = transform(m[1]);
}

function sliceBalancedObject(s: string, start: number): { text: string; complete: boolean } {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
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
      if (depth === 0) return { text: s.slice(start, i + 1), complete: true };
    }
  }
  return { text: s.slice(start), complete: false };
}

