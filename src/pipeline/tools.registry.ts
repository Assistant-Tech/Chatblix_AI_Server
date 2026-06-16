import { OpenRouterTool } from './openrouter.client';
import type { BusinessProfileDto } from '../common/types/business-profile.dto';

export const STOCK_CHECK_TOOL: OpenRouterTool = {
  type: 'function',
  function: {
    name: 'stock_check',
    description: 'Check the stock availability, price, and variants of a specific product by name.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The exact name or descriptive type of the product to check (e.g., "red t-shirt", "laptop").',
        },
      },
      required: ['query'],
    },
  },
};

export const ORDER_LOOKUP_TOOL: OpenRouterTool = {
  type: 'function',
  function: {
    name: 'order_lookup',
    description:
      "Look up a customer's order — its status, items, total, and shipping/tracking info — by its order number or tracking number.",
    parameters: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description:
            'The order number or tracking number the customer provides (e.g., "TRK12345" or an order id).',
        },
      },
      required: ['order_id'],
    },
  },
};

/**
 * A tool plus the per-tenant predicate that decides whether it should be exposed.
 * Add new tools here with their own gate; the gate is evaluated against the
 * tenant's synced BusinessProfile at generation time.
 */
interface ToolGate {
  tool: OpenRouterTool;
  /** Returns true when this tenant should be offered the tool. */
  isEnabled: (profile: BusinessProfileDto) => boolean;
}

/**
 * Commerce-tenant signal for product/order-backed tools. Today it's a proxy —
 * "the tenant has a non-empty product catalog" — because that's the only commerce
 * signal currently synced to ai-backend. FAQ-only / service tenants have no catalog
 * and so are never offered commerce tools, keeping their prompt smaller and
 * preventing spurious tool calls.
 *
 * NOTE: this is a heuristic. The target design (see docs/TOOL_CAPABILITY_ARCHITECTURE.md,
 * Phase A) replaces it with an explicit `enabled_tools` list resolved authoritatively
 * in main-backend (commerce module ∧ plan entitlement). When that lands, this
 * predicate is swapped for a lookup against that list — for both commerce tools at once.
 */
function isCommerceTenant(profile: BusinessProfileDto): boolean {
  return Array.isArray(profile?.product_catalog) && profile.product_catalog.length > 0;
}

export const CAPTURE_LEAD_TOOL: OpenRouterTool = {
  type: 'function',
  function: {
    name: 'capture_lead',
    description:
      'Record the customer as a sales lead when they express clear buying intent or ask to be contacted. ' +
      'Extract their details from the conversation. Only call this once interest is genuine.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The customer's name (required)." },
        email: { type: 'string', description: 'Email, if the customer shared one.' },
        phone: { type: 'string', description: 'Phone number, if shared.' },
        company: { type: 'string', description: 'Company name, if relevant.' },
        notes: { type: 'string', description: 'Short summary of what they are interested in.' },
      },
      required: ['name'],
    },
  },
};

/**
 * Leads capability is not visible in the synced profile, so the legacy fallback
 * predicate is conservative (off). The real gate is the published `enabled_tools`
 * list, which main-backend computes from the tenant's leads-module configuration.
 */
const TOOL_REGISTRY: ToolGate[] = [
  { tool: STOCK_CHECK_TOOL, isEnabled: isCommerceTenant },
  { tool: ORDER_LOOKUP_TOOL, isEnabled: isCommerceTenant },
  // capture_lead is retired as an LLM tool: lead capture is now done deterministically
  // from each turn's metadata in main-backend (AiHandoffService.captureLeadFromMetadata).
  // main-backend no longer publishes "capture_lead" in enabled_tools, so this entry is
  // inert; the definition is kept only so the tool could be re-enabled later if needed.
  { tool: CAPTURE_LEAD_TOOL, isEnabled: () => false },
];

/**
 * Select the tools a given tenant should be offered, based on their profile.
 * Returns an empty array when no tool applies — callers should treat that as
 * "send no tools" (i.e. pure prompted pipeline, no tool loop).
 *
 * Precedence (see docs/TOOL_CAPABILITY_ARCHITECTURE.md):
 *  1. `enabled_tools` — the explicit list resolved by main-backend. When present
 *     (including an empty array → "no tools"), it is authoritative.
 *  2. Legacy per-profile heuristic gates — fallback for profiles synced before
 *     `enabled_tools` existed.
 */
export function selectToolsForProfile(profile: BusinessProfileDto): OpenRouterTool[] {
  if (Array.isArray(profile?.enabled_tools)) {
    const enabled = new Set(profile.enabled_tools);
    return TOOL_REGISTRY.filter((g) => enabled.has(g.tool.function.name)).map((g) => g.tool);
  }

  return TOOL_REGISTRY.filter((g) => {
    try {
      return g.isEnabled(profile);
    } catch {
      return false;
    }
  }).map((g) => g.tool);
}
