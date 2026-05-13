import type { HistoryMessage } from '../types/pipeline.types';

export type DetectedLanguage = 'en' | 'romanized_ne' | 'ne_devanagari' | 'mixed';

const DEVANAGARI = /[ऀ-ॿ]/;

const NEPALI_TOKENS = new Set<string>([
  'ma', 'hami', 'tapai', 'tapailai', 'malai', 'hamro', 'tapaiko', 'mero',
  'dai', 'didi', 'bhai', 'hajur', 'namaste', 'dhanyabad',
  'ho', 'hoina', 'cha', 'chaina', 'chu', 'chau', 'chha', 'chhaina',
  'xa', 'xaina', 'xan',
  'garna', 'garchu', 'garcha', 'garera', 'garum', 'garnu', 'gareko', 'garyo',
  'garne', 'garda', 'gardai', 'gardina', 'gardaina',
  'milcha', 'milchha', 'paucha', 'paauchha', 'hunchha', 'hunch', 'huncha',
  'parcha', 'parchha', 'pardaina', 'paryo', 'parne',
  'hunna', 'hudaina', 'hudai',
  'sakcha', 'sakchha', 'sakdina', 'sakdaina', 'sakinchha', 'sakdai',
  'din', 'haptaa', 'mahina', 'barsa', 'ghanta', 'minute',
  'bhayo', 'bhaye', 'bhaneko', 'bhanyo', 'bhanchu', 'bhanchhu', 'bhane',
  'linchhu', 'linchu', 'kinchhu', 'kinchu', 'dinchhu', 'dinchu',
  'lagcha', 'lagchha', 'lagdaina',
  'kati', 'kasari', 'kun', 'kasto', 'kahile', 'kaha', 'ke',
  'ramro', 'naramro', 'thik', 'mahango', 'sasto', 'hola', 'hoss', 'hos', 'hunuhos',
  'sanga', 'sangai', 'lagi', 'kripaya', 'thaha', 'thau', 'samma', 'matra',
  'aja', 'bholi', 'hijo', 'abha', 'abo', 'ahile',
  'ek', 'chin', 'jaldai', 'thahara', 'khojeko', 'khoja',
  'sampark', 'batauna', 'bhana', 'garni',
  'tyo', 'yo', 'tyaha', 'yaha',
  'namaskar', 'khabar',
]);

const NEPALI_PARTICLES = new Set<string>([
  'ko', 'lai', 'le', 'bata', 'bhanda', 'ni',
  'pani', 'matra', 'tira', 'sanga', 'ra',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function detectLanguage(text: string, priorLanguage: DetectedLanguage | null = null): DetectedLanguage {
  if (!text || typeof text !== 'string') return priorLanguage || 'en';
  if (DEVANAGARI.test(text)) return 'ne_devanagari';

  const tokens = tokenize(text);
  if (tokens.length === 0) return priorLanguage || 'en';

  let nepaliCount = 0;
  let particleCount = 0;
  for (const t of tokens) {
    if (NEPALI_PARTICLES.has(t)) {
      particleCount++;
      nepaliCount++;
    } else if (NEPALI_TOKENS.has(t)) {
      nepaliCount++;
    }
  }

  if (particleCount > 0) return 'romanized_ne';

  if (nepaliCount === 0) {
    if (tokens.length <= 4 && priorLanguage === 'romanized_ne') {
      return 'romanized_ne';
    }
    return 'en';
  }

  const ratio = nepaliCount / tokens.length;
  if (ratio >= 0.4) return 'romanized_ne';
  return 'mixed';
}

const OVERRIDES: Record<DetectedLanguage, string> = {
  en: 'The customer\'s most recent message is in PURE ENGLISH. Your <reply> MUST be pure English with ZERO Nepali words and ZERO Nepali honorifics. Do not use: didi, dai, hajur, bhai, namaste, tapai, ho, cha, milcha, paucha, garchu, garera, hunchha, sakdina, ek chin, kripaya, sampark, thaha, jaldai, hunuhos, etc. Ignore the language of all prior assistant turns in this conversation. Set "suggested_reply_language": "en" in the metadata.',
  romanized_ne: 'The customer\'s most recent message is in ROMANIZED NEPALI. Your <reply> MUST be in Romanized Nepali (Latin script, spoken register). Set "suggested_reply_language": "romanized_ne".',
  ne_devanagari: 'The customer\'s most recent message is in DEVANAGARI NEPALI. Your <reply> MUST be in ROMANIZED Nepali (Latin script) — most Nepali customers read Romanized faster on mobile. Set "suggested_reply_language": "romanized_ne".',
  mixed: 'The customer\'s most recent message is CODE-MIXED (Nepali + English). Your <reply> MUST match their mix ratio. Set "suggested_reply_language": "mixed".',
};

export function languageOverrideMessage(detected: DetectedLanguage): string {
  return `LANGUAGE OVERRIDE (highest priority — overrides system prompt, brand_voice, prior turns, and every other instruction): ${OVERRIDES[detected] || OVERRIDES.en}`;
}

export function behaviorOverrideMessage(messages: HistoryMessage[] = []): string {
  const userTurns = messages.filter((m) => m.role === 'user');
  const assistantTurns = messages.filter((m) => m.role === 'assistant');
  const isFirstTurn = userTurns.length <= 1 && assistantTurns.length === 0;

  const haystack = messages.map((m) => String(m.content || '')).join('\n').toLowerCase();
  const FIT_SIGNALS = [
    'oily', 'dry', 'combination', 'sensitive', 'normal skin',
    'acne', 'pimple', 'dryness', 'dark spot', 'dark circle', 'pigmentation', 'dullness', 'wrinkle', 'redness',
    'haldi', 'turmeric', 'neem', 'beetroot', 'beet root', 'green tea', 'orange scrub', 'sprinkle', 'toner',
    'budget', 'under 500', 'under 1000', 'under 2000', 'rs ', 'npr ',
  ];
  const hasFitSignal = FIT_SIGNALS.some((s) => haystack.includes(s));

  if (hasFitSignal) {
    return `Now that you know what they're looking for, give them one or two solid recommendations tied directly to what they said. Skip the long explanations — keep it real and conversational. One clear next step after.`;
  }

  return `They haven't told you what they need yet. Ask ONE natural clarifying question — nothing else. No product names, no prices, no "here's what we have." Just the question.${isFirstTurn ? ' Keep your opener warm and brief, then ask.' : ''}`;
}
