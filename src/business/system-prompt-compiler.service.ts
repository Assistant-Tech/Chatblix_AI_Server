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
      renderPersona(profile),
      renderLanguage(profile),
      renderHours(profile),
      renderFaqs(profile),
      renderPolicies(profile),
      renderEscalation(profile),
    ];
    return sections.filter((s) => s.length > 0).join('\n\n');
  }
}

function renderIdentity(profile: BusinessProfileDto): string {
  return [`# ${profile.name}`, '', profile.description].join('\n');
}

function renderPersona(profile: BusinessProfileDto): string {
  const { tone } = profile;
  const lines: string[] = [
    '## PERSONA',
    `Style: ${tone.style}`,
    `You are: ${tone.persona_name}`,
  ];
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
    `Delivery: ${policies.delivery_info}`,
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

function renderEscalation(profile: BusinessProfileDto): string {
  const { escalation } = profile;
  return [
    '## ESCALATION',
    `Trigger keywords: ${escalation.triggers.join(', ')}`,
    `Handoff line: ${escalation.handoff_message}`,
  ].join('\n');
}
