import type { BusinessProfileDto } from '../src/common/types/business-profile.dto';

/**
 * A complete, valid sample tenant profile used as the default for fixtures.
 * Individual fixtures can override any part of it via `input.profilePatch`
 * (deep-merged). Modeled on a Kathmandu skincare shop so the Nepali shopkeeper
 * voice rules in the prompts are exercised.
 */
export function sampleSkincareProfile(): BusinessProfileDto {
  return {
    name: 'Glow Nepal',
    description: 'Affordable skincare for everyday Nepali skin.',
    business_type: 'skincare',
    language: 'romanized_ne',
    tone: {
      style: 'friendly',
      persona_name: 'Glow Nepal ko shopkeeper',
      persona_desc: 'Warm, brief Kathmandu shopkeeper. Never marketing-y.',
      closing_statement: 'Dhanyabad hajur!',
      do: ['Mirror the customer language', 'Keep replies short'],
      dont: ['No medical claims', 'No corporate-speak'],
    },
    hours: {
      timezone: 'Asia/Kathmandu',
      schedule: [
        { day: 'sunday', open: '10:00', close: '18:00' },
        { day: 'monday', open: '10:00', close: '18:00' },
        { day: 'tuesday', open: '10:00', close: '18:00' },
        { day: 'wednesday', open: '10:00', close: '18:00' },
        { day: 'thursday', open: '10:00', close: '18:00' },
        { day: 'friday', open: '10:00', close: '18:00' },
      ],
      holiday_message: 'Aaja banda cha hajur, bholi sampark garnu hola.',
    },
    faqs: [
      { question: 'Delivery kati din lagcha?', answer: 'Kathmandu bhitra 1-2 din, bahira 3-5 din.' },
      { question: 'Return huncha?', answer: '7 din bhitra return milcha hajur.' },
    ],
    policies: {
      return_policy: '7 days return if unused.',
      delivery_policy: 'Kathmandu 1-2 days, outside valley 3-5 days. Free over NPR 1500.',
      payment_methods: ['cod', 'esewa', 'khalti'],
    },
    escalation: {
      triggers: ['refund', 'complaint', 'lawyer'],
      handoff_message: 'Ek chin hajur, colleague le follow up garchha.',
      max_turns: 8,
    },
    product_catalog: [
      { name: 'Neem Soap', price: 499, description: 'For oily, acne-prone skin', tags: ['bestseller'] },
      { name: 'Vitamin C Serum', price: 1299, description: 'Brightening daily serum' },
      { name: 'Aloe Gel', price: 399, description: 'Soothing after-sun gel' },
    ],
    locations: [{ name: 'Kathmandu Store', address: 'New Road, Kathmandu', hours: '10-6' }],
    current_offers: [{ title: 'Festive combo', details: 'Neem Soap + Aloe Gel NPR 799', valid_until: '2026-12-31' }],
    corrections: [],
    emoji_allowed: false,
    enabled_tools: [],
  } as BusinessProfileDto;
}

/** Shallow-ish deep merge sufficient for profile patches in fixtures. */
export function deepMerge<T>(base: T, patch: Record<string, unknown> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
