import { ASSISTANT_TOOLS, ASSISTANT_TOOL_NAMES, ASSISTANT_TOOL_PATHS } from './assistant-tools.registry';
import { CAPTURE_LEAD_TOOL, ORDER_LOOKUP_TOOL, PLACE_ORDER_TOOL, STOCK_CHECK_TOOL } from '../pipeline/tools.registry';

type Schema = { type: string; properties?: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };

const schemaOf = (tool: (typeof ASSISTANT_TOOLS)[number]) => tool.function.parameters as Schema;

describe('assistant tool registry', () => {
  it('has unique names, each with an internal path', () => {
    expect(new Set(ASSISTANT_TOOL_NAMES).size).toBe(ASSISTANT_TOOL_NAMES.length);
    expect(Object.keys(ASSISTANT_TOOL_PATHS).sort()).toEqual([...ASSISTANT_TOOL_NAMES].sort());
  });

  it('shares no name with the customer reply tools', () => {
    const customer = [STOCK_CHECK_TOOL, ORDER_LOOKUP_TOOL, PLACE_ORDER_TOOL, CAPTURE_LEAD_TOOL].map((t) => t.function.name);
    expect(ASSISTANT_TOOL_NAMES.filter((n) => customer.includes(n))).toEqual([]);
  });

  it('lets the model choose neither whose data nor which window it reads', () => {
    for (const tool of ASSISTANT_TOOLS) {
      for (const param of Object.keys(schemaOf(tool).properties ?? {})) {
        expect(param).not.toMatch(/tenant|business|digest|window|date|since|until|start|end/i);
        if (param.endsWith('_id')) expect(param).toBe('conversation_id');
      }
    }
  });

  it('closes every schema to extra properties', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(schemaOf(tool)).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});
