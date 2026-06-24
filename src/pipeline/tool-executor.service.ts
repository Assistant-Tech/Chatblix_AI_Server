import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

// Upper bound on a single internal tool HTTP call. Without this, a hung
// main-backend would stall the customer-facing generation indefinitely.
const TOOL_FETCH_TIMEOUT_MS = 5000;

/** Per-turn context the executor needs. business_id is always present; the
 * conversation/contact ids are present on the real reply path (not the sandbox). */
export interface ToolContext {
  business_id: string;
  conversation_id?: string;
  contact_id?: string;
  channel?: string;
}

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly config: AppConfigService) { }

  async execute(toolName: string, args: string, ctx: ToolContext): Promise<string> {
    this.logger.log(`Executing tool=${toolName} business_id=${ctx.business_id} args=${args}`);

    switch (toolName) {
      case 'stock_check':
        return this.executeStockCheck(args, ctx.business_id);
      case 'order_lookup':
        return this.executeOrderLookup(args, ctx.business_id);
      case 'capture_lead':
        return this.executeCaptureLead(args, ctx);
      case 'place_order':
        return this.executePlaceOrder(args, ctx);
      default:
        this.logger.warn(`Unknown tool: ${toolName}`);
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }

  private async executeStockCheck(args: string, businessId: string): Promise<string> {
    const parsed = parseArgs(args);
    if (!parsed) return JSON.stringify({ error: 'Invalid JSON arguments' });
    if (!parsed.query) return JSON.stringify({ error: 'Missing required argument: query' });

    return this.callInternalTool('stock_check', 'stock-check', {
      tenantId: businessId,
      query: parsed.query,
    });
  }

  private async executeOrderLookup(args: string, businessId: string): Promise<string> {
    const parsed = parseArgs(args);
    if (!parsed) return JSON.stringify({ error: 'Invalid JSON arguments' });
    if (!parsed.order_id) return JSON.stringify({ error: 'Missing required argument: order_id' });

    return this.callInternalTool('order_lookup', 'order-lookup', {
      tenantId: businessId,
      orderId: String(parsed.order_id),
    });
  }

  private async executeCaptureLead(args: string, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(args);
    if (!parsed) return JSON.stringify({ error: 'Invalid JSON arguments' });
    // conversation_id is injected server-side and is required (a lead is keyed to the
    // conversation). Absent on the sandbox path → degrade gracefully.
    if (!ctx.conversation_id) {
      return JSON.stringify({ error: 'capture_lead is only available in a live conversation' });
    }
    if (!parsed.name) return JSON.stringify({ error: 'Missing required argument: name' });

    return this.callInternalTool('capture_lead', 'capture-lead', {
      tenantId: ctx.business_id,
      conversationId: ctx.conversation_id,
      contactId: ctx.contact_id ?? null,
      name: String(parsed.name),
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      company: parsed.company ?? null,
      notes: parsed.notes ?? null,
    });
  }

  private async executePlaceOrder(args: string, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(args);
    if (!parsed) return JSON.stringify({ error: 'Invalid JSON arguments' });
    if (!ctx.conversation_id) {
      return JSON.stringify({ error: 'place_order is only available in a live conversation' });
    }
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return JSON.stringify({ error: 'Missing required argument: items' });
    }

    return this.callInternalTool('place_order', 'place-order', {
      tenantId: ctx.business_id,
      conversationId: ctx.conversation_id,
      channel: ctx.channel ?? null,
      items: parsed.items,
      customerName: parsed.customer_name ?? null,
      phone: parsed.phone ?? null,
      address: parsed.address ?? null,
    });
  }

  /**
   * Shared internal-tool HTTP call. Applies the auth header and a hard timeout,
   * and normalizes all failure modes into a JSON error string so the LLM always
   * gets a well-formed tool result and degrades gracefully.
   */
  private async callInternalTool(
    toolName: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const url = `${this.config.mainBackendInternalUrl()}/api/v1/internal/ai/tools/${path}`;
    const token = this.config.mainBackendInternalToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        this.logger.error(`${toolName} failed status=${response.status} response=${errText}`);
        return JSON.stringify({ error: `Internal API error during ${toolName}` });
      }

      const data = await response.json();
      return JSON.stringify(data);
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        this.logger.error(`${toolName} timed out after ${TOOL_FETCH_TIMEOUT_MS}ms`);
        return JSON.stringify({ error: `${toolName} timed out` });
      }
      this.logger.error(`Error executing ${toolName}: ${err?.message}`);
      return JSON.stringify({ error: `Failed to execute ${toolName} due to network or parsing error` });
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseArgs(args: string): Record<string, any> | null {
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return null;
  }
}
