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
 * Signal for product-backed tools: the tenant has at least one product in their
 * synced catalog. FAQ-only / service tenants have no catalog, so they never get
 * `stock_check` — which keeps their prompt smaller and prevents spurious tool
 * calls. Change this predicate if a different capability signal becomes available
 * on the profile (e.g. an explicit `enabled_tools` / commerce-module flag).
 */
function hasProductCatalog(profile: BusinessProfileDto): boolean {
  return Array.isArray(profile?.product_catalog) && profile.product_catalog.length > 0;
}

const TOOL_REGISTRY: ToolGate[] = [
  { tool: STOCK_CHECK_TOOL, isEnabled: hasProductCatalog },
];

/**
 * Select the tools a given tenant should be offered, based on their profile.
 * Returns an empty array when no tool applies — callers should treat that as
 * "send no tools" (i.e. pure prompted pipeline, no tool loop).
 */
export function selectToolsForProfile(profile: BusinessProfileDto): OpenRouterTool[] {
  return TOOL_REGISTRY.filter((g) => {
    try {
      return g.isEnabled(profile);
    } catch {
      return false;
    }
  }).map((g) => g.tool);
}
