import type { HistoryMessage } from '../types/pipeline.types';

const BUYING_KEYWORDS =
  /\b(buy|order|purchase|book|reserve|place\s*order|place\s*the\s*order|confirm|i'?ll\s*take|i\s*want\s*it|i\s*need\s*it|how\s*do\s*i\s*pay|payment|checkout|cod\b|cash\s*on\s*delivery)\b/i;
const COMPARISON_KEYWORDS =
  /\b(compare|vs\.?|versus|difference|better|which\s+(one|model|plan)|which\s+is\s+better|recommend)\b/i;
const COMPLAINT_KEYWORDS =
  /\b(complaint|complain|refund|broken|damaged|not\s*working|wrong\s*order|late\s*delivery|fraud|cheated)\b/i;
const SUPPORT_KEYWORDS = /\b(support|help|how\s*to|tutorial|guide|stuck|issue\s*with)\b/i;
const HUMAN_REQUEST = /\b(human|agent|talk\s*to\s*(a\s*)?person|real\s*person|representative)\b/i;
const URGENCY_NOW = /\b(now|today|right\s*away|asap|urgent|immediately)\b/i;
const URGENCY_SOON =
  /\b(this\s*week|tomorrow|next\s*few\s*days|soon|by\s*friday|by\s*monday|by\s*sunday)\b/i;
const URGENCY_LATER = /\b(this\s*month|next\s*month|in\s*a\s*few\s*weeks)\b/i;
const SPECIFICS_KEYWORDS =
  /\b(size|fit|color|colour|available|in\s*stock|stock|small|medium|large|xl|xxl|measurement|length|waist|chest)\b/i;
const LOGISTICS_KEYWORDS =
  /\b(delivery|deliver|shipping|ship|pickup|pick\s*up|collect|store|address|kitne\s*din|kati\s*din)\b/i;
const PRICE_KEYWORDS = /\b(price|cost|how\s*much|kati\s*ho|paisa|kati\s*parcha|charge|emi|installment)\b/i;

const STAGE_BY_SCORE = (score: number): string => {
  if (score >= 80) return 'closing';
  if (score >= 55) return 'hot';
  if (score >= 30) return 'warm';
  return 'cold';
};

const NEXT_ACTION_BY_STAGE: Record<string, string> = {
  cold: 'qualify',
  warm: 'recommend',
  hot: 'close',
  closing: 'close',
  won: 'follow_up',
  lost: 'follow_up',
};

const STAGE_RANK: Record<string, number> = { cold: 0, warm: 1, hot: 2, closing: 3, won: 4 };

function detectIntent(userMessage: string, llmIntent?: string): string {
  if (COMPLAINT_KEYWORDS.test(userMessage)) return 'complaint';
  if (BUYING_KEYWORDS.test(userMessage)) return 'ready_to_buy';
  if (COMPARISON_KEYWORDS.test(userMessage)) return 'comparison';
  if (SUPPORT_KEYWORDS.test(userMessage)) return 'support';
  const VALID = new Set(['inquiry', 'comparison', 'ready_to_buy', 'complaint', 'support']);
  if (llmIntent && VALID.has(llmIntent)) return llmIntent;
  return 'inquiry';
}

function detectTimeline(userMessage: string, current: string | null | undefined): string | null {
  if (URGENCY_NOW.test(userMessage)) return 'immediate';
  if (URGENCY_SOON.test(userMessage)) return 'this_week';
  if (URGENCY_LATER.test(userMessage)) return 'this_month';
  return current || null;
}

export interface MomentumInput {
  history?: HistoryMessage[];
  userMessage?: string;
  extractedData?: Record<string, unknown>;
  priorExtractedData?: Record<string, unknown>;
  priorLead?: { lead_score?: number | null; stage?: string | null };
  llmIntent?: string;
}

export interface MomentumResult {
  lead_score: number;
  score_delta: number;
  stage: string;
  intent: string;
  next_action: string;
  tags: string[];
  handoff_required: boolean;
  timeline: string | null;
  last_signal: string;
  turn_reasons: string[];
}

export function computeMomentum(ctx: MomentumInput): MomentumResult {
  const {
    history = [],
    userMessage = '',
    extractedData = {},
    priorExtractedData = {},
    priorLead = {},
    llmIntent,
  } = ctx;

  const customerTurns = history.filter((m) => m.role === 'user').length;

  let score = 0;
  const tags: string[] = [];
  const turnReasons: string[] = [];

  const newlyCaptured = (key: string): boolean =>
    Boolean(extractedData[key]) && !priorExtractedData[key];

  score += Math.min(customerTurns * 6, 30);
  if (customerTurns >= 2) tags.push('engaged');

  if (extractedData.phone) {
    score += 30;
    tags.push('contact_captured');
    if (newlyCaptured('phone')) turnReasons.push('Phone captured');
  }
  if (extractedData.email) {
    score += 20;
    tags.push('contact_captured');
    if (newlyCaptured('email')) turnReasons.push('Email captured');
  }
  if (extractedData.name) {
    score += 10;
    if (newlyCaptured('name')) turnReasons.push('Name captured');
  }
  if (extractedData.location) {
    score += 8;
    if (newlyCaptured('location')) turnReasons.push('Location shared');
  }
  if (extractedData.product_interest) {
    score += 12;
    if (newlyCaptured('product_interest')) turnReasons.push('Product interest noted');
  }
  if (extractedData.budget_range) {
    score += 15;
    tags.push('budget_known');
    if (newlyCaptured('budget_range')) turnReasons.push('Budget shared');
  }

  const timeline = detectTimeline(userMessage, extractedData.timeline as string | undefined);
  if (timeline === 'immediate') {
    score += 20;
    tags.push('urgent');
    if (timeline !== priorExtractedData.timeline) turnReasons.push('Wants it now');
  } else if (timeline === 'this_week') {
    score += 12;
    if (timeline !== priorExtractedData.timeline) turnReasons.push('Buying this week');
  } else if (timeline === 'this_month') {
    score += 6;
  }

  if (BUYING_KEYWORDS.test(userMessage)) {
    score += 18;
    tags.push('buying_intent');
    turnReasons.push('Buying intent detected');
  }
  if (PRICE_KEYWORDS.test(userMessage)) {
    score += 8;
    tags.push('price_inquiry');
    turnReasons.push('Asking about price');
  }
  if (LOGISTICS_KEYWORDS.test(userMessage)) {
    score += 6;
    tags.push('logistics_inquiry');
    turnReasons.push('Asking about delivery');
  }
  if (SPECIFICS_KEYWORDS.test(userMessage)) {
    score += 5;
    tags.push('product_specifics');
    turnReasons.push('Asking about product details');
  }
  if (COMPARISON_KEYWORDS.test(userMessage)) {
    score += 6;
    turnReasons.push('Comparing options');
  }

  const objections = Array.isArray(extractedData.objections) ? extractedData.objections : [];
  if (objections.length > 0) {
    score -= objections.length * 4;
    tags.push('has_objections');
  }

  const isComplaint = COMPLAINT_KEYWORDS.test(userMessage);
  const wantsHuman = HUMAN_REQUEST.test(userMessage);
  if (isComplaint) {
    score = Math.min(score, 40);
    tags.push('escalation');
    turnReasons.push('Complaint detected — escalating');
  }
  if (wantsHuman) turnReasons.push('Customer requested human');

  score = Math.max(0, Math.min(100, Math.round(score)));

  const priorScore = Number(priorLead?.lead_score) || 0;
  if (!isComplaint) score = Math.max(score, priorScore);

  let stage = STAGE_BY_SCORE(score);
  const priorStage = priorLead?.stage;
  if (priorStage && priorStage !== 'lost' && (STAGE_RANK[priorStage] ?? -1) > (STAGE_RANK[stage] ?? -1)) {
    stage = priorStage;
  }

  const intent = detectIntent(userMessage, llmIntent);
  let next_action = NEXT_ACTION_BY_STAGE[stage] || 'qualify';
  const handoff_required = isComplaint || wantsHuman;
  if (handoff_required) next_action = 'escalate';

  if (priorStage && stage !== priorStage) {
    turnReasons.unshift(`Stage moved: ${priorStage} → ${stage}`);
  } else if (!priorStage && stage !== 'cold') {
    turnReasons.unshift(`Stage set to ${stage}`);
  }

  const last_signal =
    turnReasons[0] || (customerTurns <= 1 ? 'Conversation started' : 'Continuing the conversation');
  const score_delta = score - priorScore;

  return {
    lead_score: score,
    score_delta,
    stage,
    intent,
    next_action,
    tags,
    handoff_required,
    timeline,
    last_signal,
    turn_reasons: turnReasons,
  };
}
