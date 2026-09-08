import {
  selectToolsForProfile,
  STOCK_CHECK_TOOL,
  ORDER_LOOKUP_TOOL,
  PLACE_ORDER_TOOL,
  CAPTURE_LEAD_TOOL,
} from './tools.registry';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';

function profile(overrides: Partial<BusinessProfileDto> = {}): BusinessProfileDto {
  return { name: 'T', ...overrides } as BusinessProfileDto;
}

describe('selectToolsForProfile — per-tenant gating', () => {
  it('exposes commerce read tools (stock_check + order_lookup) for a commerce tenant', () => {
    const tools = selectToolsForProfile(
      profile({ product_catalog: [{ name: 'Red Shirt' }] as any }),
    );
    expect(tools).toContain(STOCK_CHECK_TOOL);
    expect(tools).toContain(ORDER_LOOKUP_TOOL);
    // place_order is retired as an LLM tool (writes are metadata-driven)
    expect(tools).not.toContain(PLACE_ORDER_TOOL);
  });

  it('exposes no tools when the catalog is empty', () => {
    expect(selectToolsForProfile(profile({ product_catalog: [] }))).toEqual([]);
  });

  it('exposes no tools when the catalog is absent (FAQ-only tenant)', () => {
    expect(selectToolsForProfile(profile())).toEqual([]);
  });

  it('does not throw on a malformed profile', () => {
    expect(selectToolsForProfile(undefined as any)).toEqual([]);
  });

  describe('enabled_tools precedence (Phase A)', () => {
    it('uses the explicit enabled_tools list when present, ignoring the heuristic', () => {
      // No catalog (heuristic would give nothing) but explicitly entitled.
      const tools = selectToolsForProfile(profile({ enabled_tools: ['order_lookup'] } as any));
      expect(tools).toEqual([ORDER_LOOKUP_TOOL]);
      expect(tools).not.toContain(STOCK_CHECK_TOOL);
    });

    it('treats an explicit empty enabled_tools as "no tools", overriding the catalog heuristic', () => {
      const tools = selectToolsForProfile(
        profile({ product_catalog: [{ name: 'X' }], enabled_tools: [] } as any),
      );
      expect(tools).toEqual([]);
    });

    it('ignores unknown tool names in enabled_tools', () => {
      const tools = selectToolsForProfile(
        profile({ enabled_tools: ['stock_check', 'made_up_tool'] } as any),
      );
      expect(tools).toEqual([STOCK_CHECK_TOOL]);
    });

    it('falls back to the heuristic when enabled_tools is absent (legacy profile)', () => {
      const tools = selectToolsForProfile(profile({ product_catalog: [{ name: 'X' }] } as any));
      expect(tools).toContain(STOCK_CHECK_TOOL);
      expect(tools).toContain(ORDER_LOOKUP_TOOL);
    });

    it('exposes capture_lead only via explicit enabled_tools (no heuristic fallback)', () => {
      // Heuristic fallback never offers the write tool...
      expect(selectToolsForProfile(profile({ product_catalog: [{ name: 'X' }] } as any))).not.toContain(
        CAPTURE_LEAD_TOOL,
      );
      // ...but an explicit entitlement does.
      expect(selectToolsForProfile(profile({ enabled_tools: ['capture_lead'] } as any))).toEqual([
        CAPTURE_LEAD_TOOL,
      ]);
    });
  });
});
