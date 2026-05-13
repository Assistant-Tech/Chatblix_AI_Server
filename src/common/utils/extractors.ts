const NEPALI_MOBILE = /(?<![\w\d])(?:\+?977[-\s]?)?(9[678]\d{8})(?![\w\d])/;
const GENERIC_PHONE = /(?<![\w\d])(\+?\d{1,3}[-\s]?)?(\d{10,12})(?![\w\d])/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const NAME_PHRASES: RegExp[] = [
  /(?:my name is|i am|i'm|this is|name[:\s]+is)\s+([A-Z][a-zA-Z]{1,15}(?:\s+[A-Z][a-zA-Z]{1,15})?)/i,
  /(?:mero naam|ma)\s+([A-Z][a-zA-Z]{1,15}(?:\s+[A-Z][a-zA-Z]{1,15})?)\s+(?:hu|ho)/i,
];

const BUDGET_PHRASES: RegExp[] = [
  /(?:budget|under|below|max|maximum|around|about|upto|up\s*to)\s*(?:is|of|:)?\s*(?:₹|rs\.?|npr|inr)?\s*([\d,]{3,7})(?:\s*k\b)?/i,
  /(?:₹|rs\.?|npr|inr)\s*([\d,]{3,7})/i,
  /\b([\d,]{3,7})\s*(?:rs\.?|npr|rupees?|taka)\b/i,
  /\b(\d{1,3})\s*k\b/i,
];

const LOCATION_TERMS = [
  'kathmandu', 'ktm', 'lalitpur', 'patan', 'bhaktapur', 'pokhara', 'biratnagar',
  'birgunj', 'dharan', 'butwal', 'hetauda', 'nepalgunj', 'janakpur', 'itahari',
  'chitwan', 'bharatpur', 'dhangadhi', 'mahendranagar', 'bhairahawa',
  'thamel', 'baneshwor', 'balaju', 'jawalakhel', 'kalanki', 'koteshwor',
  'delhi', 'mumbai', 'bangalore', 'kolkata',
];
const LOCATION_RE = new RegExp(`\\b(${LOCATION_TERMS.join('|')})\\b`, 'i');

function normalizeBudget(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).replace(/[,\s]/g, '');
}

export interface ExtractedContact {
  phone?: string;
  email?: string;
  name?: string;
  budget_range?: string;
  location?: string;
  address?: string;
}

export function extractContactInfo(text: string): ExtractedContact {
  if (!text || typeof text !== 'string') return {};
  const out: ExtractedContact = {};

  const m1 = text.match(NEPALI_MOBILE);
  if (m1) {
    out.phone = m1[1];
  } else {
    const m2 = text.match(GENERIC_PHONE);
    if (m2) out.phone = (m2[1] || '') + m2[2];
  }

  const m3 = text.match(EMAIL);
  if (m3) out.email = m3[0];

  const NAME_BLOCK = new Set([
    'from', 'in', 'at', 'to', 'going', 'looking', 'interested', 'trying',
    'the', 'a', 'an', 'this', 'that', 'here', 'there', 'just',
    'checking', 'wondering', 'asking', 'thinking', 'calling', 'writing',
    'very', 'still', 'really', 'ok', 'okay', 'yes', 'no',
  ]);
  for (const re of NAME_PHRASES) {
    const m = text.match(re);
    if (m) {
      const cleaned = m[1].trim().replace(/\s+(from|in|at|to|of)$/i, '');
      const firstWord = cleaned.split(/\s+/)[0].toLowerCase();
      if (cleaned && !NAME_BLOCK.has(firstWord)) {
        out.name = cleaned;
      }
      break;
    }
  }

  for (const re of BUDGET_PHRASES) {
    const m = text.match(re);
    if (m) {
      const num = normalizeBudget(m[1]);
      if (!num) continue;
      const isK = /\d\s*k\b/i.test(m[0]) && Number(num) < 1000;
      const value = isK ? `${Number(num) * 1000}` : num;
      if (Number(value) >= 500) {
        out.budget_range = value;
        break;
      }
    }
  }

  const loc = text.match(LOCATION_RE);
  if (loc) {
    const city = loc[1].toLowerCase();
    out.location = city === 'ktm' ? 'Kathmandu' : city.charAt(0).toUpperCase() + city.slice(1);
  }

  const ADDRESS_CUES = /\b(tole|marg|chowk|ward|sadak|street|road|rd|gali|near|bata|samu|nagar|colony|height|tower|apartment|building)\b/i;
  const HOUSE_NUM = /\b(?:ward[-\s]?\d+|house\s*no\.?|h\.?no\.?)\b/i;
  const looksLikeAddress = !!loc || ADDRESS_CUES.test(text) || HOUSE_NUM.test(text);
  if (looksLikeAddress) {
    const cleaned = text.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (cleaned) out.address = cleaned;
  }

  return out;
}
