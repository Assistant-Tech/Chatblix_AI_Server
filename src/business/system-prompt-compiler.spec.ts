import { SystemPromptCompilerService } from './system-prompt-compiler.service';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';

const compiler = new SystemPromptCompilerService();

function profile(overrides: Partial<BusinessProfileDto> = {}): BusinessProfileDto {
  return {
    name: 'Test Shop',
    description: 'desc',
    business_type: 'skincare',
    language: 'romanized_ne',
    tone: { style: 'friendly', persona_name: 'Rep', do: [], dont: [] },
    hours: { timezone: 'Asia/Kathmandu', schedule: [], holiday_message: 'Closed' },
    faqs: [],
    policies: { return_policy: '7d', delivery_policy: '1-2d', payment_methods: ['cod'] },
    escalation: { triggers: [], handoff_message: 'Team will follow up' },
    ...overrides,
  } as BusinessProfileDto;
}

function section(text: string, heading: string): string {
  const i = text.indexOf(heading);
  if (i < 0) return '';
  const next = text.indexOf('\n## ', i + heading.length);
  return text.slice(i, next < 0 ? undefined : next);
}

describe('closing flow (I2 — tenant override)', () => {
  it('renders a custom closing flow from profile.closing_flow, overriding the business_type enum', () => {
    const out = compiler.compile(
      profile({
        business_type: 'course',
        closing_flow: {
          type: 'enrollment',
          stage1_captures: ['naam', 'phone', 'preferred batch'],
          stage3_confirms: ['naam', 'course', 'phone', 'batch start date'],
          vocabulary: ["'enrollment confirm garchu' not 'parcel pathaucha'"],
        },
      }),
    );
    const block = section(out, '## CLOSING FLOW');
    expect(block).toContain('Type: enrollment');
    expect(block).toContain('Stage 1 captures: naam, phone, preferred batch.');
    expect(block).toContain('batch start date');
    expect(block).toContain("'enrollment confirm garchu' not 'parcel pathaucha'");
    // must NOT leak the delivery-enum vocabulary
    expect(block).not.toContain('parcel, dispatch, delivery address');
  });

  it('falls back to the business_type enum when closing_flow is absent', () => {
    const out = compiler.compile(profile({ business_type: 'clothing' }));
    expect(section(out, '## CLOSING FLOW')).toContain('Type: delivery');
  });

  it('falls back to the enum when closing_flow carries no usable content', () => {
    const out = compiler.compile(profile({ business_type: 'salon', closing_flow: {} }));
    expect(section(out, '## CLOSING FLOW')).toContain('Type: appointment');
  });
});

describe('catalog grounding guard (Phase 1)', () => {
  it('emits CATALOG — EMPTY with a no-sell instruction when there is no catalog and no tools', () => {
    const block = section(compiler.compile(profile()), '## CATALOG');
    expect(block).toContain('CATALOG — EMPTY');
    expect(block).toMatch(/NEVER/i);
  });

  it('emits a use-tools catalog block when commerce tools are enabled but no inline catalog', () => {
    const block = section(compiler.compile(profile({ enabled_tools: ['stock_check'] })), '## CATALOG');
    expect(block).toContain('none inline');
    expect(block).toContain('stock_check');
  });

  it('renders the authoritative catalog when products exist', () => {
    const block = section(
      compiler.compile(profile({ product_catalog: [{ name: 'Neem Soap', price: 499 } as any] })),
      '## CATALOG',
    );
    expect(block).toContain('authoritative');
    expect(block).toContain('Neem Soap NPR 499');
  });
});
