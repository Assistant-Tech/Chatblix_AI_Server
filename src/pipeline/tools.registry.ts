import { OpenRouterTool } from './openrouter.client';

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

// In the future, this can be filtered per-tenant. For now, we expose it globally.
export const AVAILABLE_TOOLS: OpenRouterTool[] = [STOCK_CHECK_TOOL];
