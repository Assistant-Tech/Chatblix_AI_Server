import { Injectable } from '@nestjs/common';
import {
  BusinessProfileDto,
  ScheduleEntryDto,
  WEEKDAYS,
  Weekday,
} from '../common/types/business-profile.dto';

const WEEKDAY_ORDER: Record<Weekday, number> = WEEKDAYS.reduce(
  (acc, day, idx) => {
    acc[day] = idx;
    return acc;
  },
  {} as Record<Weekday, number>,
);

@Injectable()
export class SystemPromptCompilerService {
  compile(profile: BusinessProfileDto): string {
    const sections: string[] = [
      renderIdentity(profile),
      renderBusinessType(profile),
      renderPersona(profile),
      renderLanguage(profile),
      renderHours(profile),
      renderLocations(profile),
      renderCatalog(profile),
      renderOffers(profile),
      renderFaqs(profile),
      renderPolicies(profile),
      renderEscalation(profile),
      renderClosingFlow(profile),
      renderConcernTriggers(profile),
      renderCorrections(profile),
    ];
    return sections.filter((s) => s.length > 0).join('\n\n');
  }
}

function renderIdentity(profile: BusinessProfileDto): string {
  return [`# ${profile.name}`, '', profile.description].join('\n');
}

// Worked examples in the common stage prompts are skincare-shop content. This
// block tells the LLM the actual domain of THIS tenant and how to re-skin the
// example patterns. Without it, a clothing/food/salon tenant would inherit
// skincare framing (e.g. "2-3 hapta ma farak dekhincha" — meaningless for a
// shirt) when the model pattern-matches from those examples.
const DOMAIN_ADAPTATION_BY_TYPE: Record<string, string[]> = {
  skincare: [
    'Outcome cues reference visible skin improvement: "2-3 hapta ma farak dekhincha", "daily lagaunu hola".',
    'Concerns frame as skin issues (pimple, daag, dryness, oiliness). Mechanism/ingredient talk stays OUT unless asked.',
  ],
  clothing: [
    'Outcome cues reference fit, feel, durability, color: "fit ramro huncha", "wash garda color kayam rahancha", "fabric soft cha hajur".',
    'Concerns frame as size/fit/fabric/occasion. Replace skincare timeframes ("2-3 hapta") with apparel-relevant cues ("regular wash ma kayam rahancha", "festive ko lagi perfect").',
    'When in doubt about size, ask for measurements or recommend exchange policy — never guess.',
  ],
  food: [
    'Outcome cues reference freshness, taste, prep time, hygiene: "fresh banaeko cha", "30 min ma puguncha", "spice level adjust garna sakcha".',
    'Concerns frame as timing/freshness/dietary (veg, jain, allergy). Replace skincare timeframes with delivery ETAs.',
    'On allergy/medical-diet mention, route to handoff — never claim safety.',
  ],
  salon: [
    'Outcome cues reference service duration, booking, skill: "30-45 min lagcha", "booking chahincha", "experienced stylist le garcha".',
    'Concerns frame as appointment timing, service fit, prior-treatment compatibility. Replace product-recommendation patterns with service-recommendation patterns.',
    'Walk-in vs appointment status must come from BUSINESS_CONTEXT — never invent slots.',
  ],
  electronics: [
    'Outcome cues reference warranty, specs, brand, after-sales: "1 year warranty cha", "spare parts milcha", "brand authorized dealer hami".',
    'Concerns frame as compatibility/warranty/reliability. Avoid skincare-style "regular use le farak aaucha" framing — electronics are pass/fail products.',
    'Never quote specs not in BUSINESS_CONTEXT.product_catalog.',
  ],
  service: [
    'Outcome cues reference turnaround, expertise, scope of work: "2-3 din ma complete huncha", "experienced team", "site visit chahincha bhane bhanidinu".',
    'Concerns frame as scope, timeline, credentials. Replace product-pitch patterns with service-quote patterns.',
    'Pricing for custom services usually needs a quote — route to handoff if asked for a flat number.',
  ],
};

function renderBusinessType(profile: BusinessProfileDto): string {
  const type = profile.business_type?.trim();
  if (!type) return '';

  const lines: string[] = ['## BUSINESS TYPE & DOMAIN ADAPTATION', `Type: ${type}`, ''];

  const adaptation = DOMAIN_ADAPTATION_BY_TYPE[type.toLowerCase()];
  if (adaptation) {
    lines.push('Adapt the example patterns in the stage instructions to this domain:');
    for (const line of adaptation) {
      lines.push(`- ${line}`);
    }
  } else {
    lines.push(
      `Adapt outcome cues, pacing, and product framing to a ${type} business. The worked examples in the stage instructions use a skincare shop's products and timeframes; do not reuse skincare-specific framing (e.g. "2-3 hapta ma farak dekhincha") unless it genuinely fits ${type}. Quote ONLY from BUSINESS_CONTEXT for catalog, prices, and policies.`,
    );
  }
  return lines.join('\n');
}

function renderPersona(profile: BusinessProfileDto): string {
  const { tone } = profile;
  const lines: string[] = [
    '## PERSONA',
    `Style: ${tone.style}`,
    `You are: ${tone.persona_name}`,
  ];
  if (tone.persona_desc?.trim()) {
    lines.push('', 'Custom instructions:', tone.persona_desc.trim());
  }
  if (profile.emoji_allowed === false) {
    lines.push('Emoji: not allowed — never use emoji anywhere in your replies.');
  } else if (profile.emoji_allowed === true) {
    lines.push('Emoji: allowed.');
  }
  if (tone.do.length > 0) {
    lines.push('', 'Always:');
    for (const item of tone.do) {
      lines.push(`- ${item}`);
    }
  }
  if (tone.dont.length > 0) {
    lines.push('', 'Never:');
    for (const item of tone.dont) {
      lines.push(`- ${item}`);
    }
  }
  if (tone.closing_statement?.trim()) {
    lines.push('', `Closing line: ${tone.closing_statement.trim()}`);
  }
  return lines.join('\n');
}

function renderLanguage(profile: BusinessProfileDto): string {
  return ['## LANGUAGE', `Primary: ${profile.language}`].join('\n');
}

function renderHours(profile: BusinessProfileDto): string {
  const { hours } = profile;
  const lines: string[] = [
    '## HOURS',
    `Timezone: ${hours.timezone}`,
    '',
    'Schedule:',
  ];
  const sorted = [...hours.schedule].sort(compareSchedule);
  if (sorted.length === 0) {
    lines.push('- (no scheduled open hours)');
  } else {
    for (const entry of sorted) {
      lines.push(`- ${entry.day}: ${entry.open} – ${entry.close}`);
    }
  }
  lines.push('', 'When closed, respond with:', `> ${hours.holiday_message}`);
  return lines.join('\n');
}

function compareSchedule(a: ScheduleEntryDto, b: ScheduleEntryDto): number {
  const ad = WEEKDAY_ORDER[a.day] ?? 99;
  const bd = WEEKDAY_ORDER[b.day] ?? 99;
  if (ad !== bd) return ad - bd;
  return a.open.localeCompare(b.open);
}

function renderLocations(profile: BusinessProfileDto): string {
  const locations = profile.locations ?? [];
  if (locations.length === 0) return '';
  const lines: string[] = ['## LOCATIONS'];
  for (const loc of locations) {
    const parts: string[] = [`- ${loc.name}`];
    if (loc.address) parts.push(`(${loc.address})`);
    if (loc.hours) parts.push(`[${loc.hours}]`);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

function renderCatalog(profile: BusinessProfileDto): string {
  const catalog = profile.product_catalog ?? [];
  if (catalog.length === 0) return '';
  const lines: string[] = ['## CATALOG (authoritative — quote only from here)'];
  for (const p of catalog) {
    const parts: string[] = [`- ${p.name}`];
    if (typeof p.price === 'number') parts.push(`NPR ${p.price}`);
    if (p.description) parts.push(`— ${p.description}`);
    if (p.tags && p.tags.length > 0) parts.push(`[${p.tags.join(', ')}]`);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

function renderOffers(profile: BusinessProfileDto): string {
  const offers = profile.current_offers ?? [];
  if (offers.length === 0) return '';
  const lines: string[] = ['## CURRENT OFFERS'];
  for (const o of offers) {
    const trailing = o.valid_until ? ` (valid until ${o.valid_until})` : '';
    lines.push(`- ${o.title}: ${o.details}${trailing}`);
  }
  return lines.join('\n');
}

function renderFaqs(profile: BusinessProfileDto): string {
  if (profile.faqs.length === 0) return '';
  const lines: string[] = ['## FAQS (ground truth — do not invent answers)'];
  for (const faq of profile.faqs) {
    lines.push('', `Q: ${faq.question}`, `A: ${faq.answer}`);
  }
  return lines.join('\n');
}

function renderPolicies(profile: BusinessProfileDto): string {
  const { policies } = profile;
  const lines: string[] = [
    '## POLICIES',
    `Returns: ${policies.return_policy}`,
    `Delivery: ${policies.delivery_policy}`,
    `Payment methods: ${policies.payment_methods.join(', ')}`,
  ];
  if (policies.custom && policies.custom.length > 0) {
    lines.push('', 'Custom:');
    for (const item of policies.custom) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join('\n');
}

function renderClosingFlow(profile: BusinessProfileDto): string {
  const type = profile.business_type?.trim().toLowerCase();
  const lines: string[] = ['## CLOSING FLOW'];

  if (type === 'salon') {
    lines.push(
      'Type: appointment',
      '',
      'Stage 1 captures: naam, phone, preferred date + time.',
      'Stage 2 collects whichever of naam / phone / datetime is missing.',
      'Stage 3 confirms: naam, service, phone, appointment datetime.',
      '',
      'Vocabulary:',
      '  - "booking confirm garchu" not "parcel pathaucha"',
      '  - "Appointment: [datetime]" not "Delivery: [address]"',
      '  - "Details confirm, shortly connect garchhau" not "Payment link pathaucha"',
    );
  } else if (type === 'service') {
    lines.push(
      'Type: service quote',
      '',
      'Stage 1 captures: naam, phone, brief scope of work.',
      'Stage 2 collects whichever of naam / phone / scope is missing.',
      'Stage 3 confirms: naam, service description, phone, timeline.',
      '',
      'Vocabulary:',
      '  - "team visit arrange garchu" or "quote pathaucha" not "parcel pathaucha"',
      '  - "Scope: [scope]" not "Delivery: [address]"',
    );
  } else {
    lines.push(
      'Type: delivery',
      '',
      'Stage 1 captures: naam, phone, delivery address.',
      'Stage 2 collects whichever of naam / phone / address / address_specifics is missing.',
      'Stage 3 confirms: naam, product + price, phone, delivery address.',
      '',
      'Vocabulary: parcel, dispatch, delivery address.',
    );
  }

  return lines.join('\n');
}

function renderConcernTriggers(profile: BusinessProfileDto): string {
  const type = profile.business_type?.trim().toLowerCase();
  if (!type) return '';

  const examplesByType: Record<string, string> = {
    skincare: 'pimple, daag, oily skin, dry skin, hair fall, glow, dark circles, dullness',
    clothing: 'size/fit issue, color fading after wash, fabric feel, shrinkage, occasion mismatch',
    food: 'late delivery, wrong order received, dietary need (veg/jain/allergy), food quality',
    salon: 'prior treatment reaction, skin/hair sensitivity before service, incompatible prior treatment',
    electronics: 'product not working, compatibility issue, warranty concern, damage in transit',
    service: 'scope uncertainty, timeline concern, credentials doubt, cost overrun worry',
  };

  const examples = examplesByType[type];
  const body = examples
    ? `Domain-specific concern triggers for ${type}: ${examples}.`
    : `Route to concern when the customer raises a problem or need related to a ${type} product or service.`;

  return ['## CONCERN TRIGGERS', body].join('\n');
}

function renderCorrections(profile: BusinessProfileDto): string {
  const corrections = profile.corrections ?? [];
  if (corrections.length === 0) return '';
  const lines: string[] = [
    '## TEACHING CORRECTIONS',
    'The business owner corrected these replies. Match their exact tone, vocabulary, language mix, and phrasing as closely as possible.',
    'When the current message is similar to a Customer example below, your reply MUST follow the Ideal reply pattern closely — same words, same structure, same level of detail.',
    '',
  ];
  for (const c of corrections) {
    lines.push(`Customer: ${c.question}`);
    lines.push(`Ideal reply: ${c.corrected}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderEscalation(profile: BusinessProfileDto): string {
  const { escalation } = profile;
  const lines = ['## ESCALATION'];
  if (escalation.triggers.length > 0) {
    lines.push(`Trigger keywords: ${escalation.triggers.join(', ')}`);
  }
  if (escalation.max_turns !== undefined) {
    lines.push(`Max AI turns before handoff: ${escalation.max_turns}`);
  }
  if (escalation.sentiment_threshold) {
    lines.push(`Escalate on sentiment: ${escalation.sentiment_threshold}`);
  }
  lines.push(`Handoff line: ${escalation.handoff_message}`);
  return lines.join('\n');
}