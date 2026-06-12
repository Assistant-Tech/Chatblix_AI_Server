import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

// Upper bound on a single internal tool HTTP call. Without this, a hung
// main-backend would stall the customer-facing generation indefinitely.
const TOOL_FETCH_TIMEOUT_MS = 5000;

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly config: AppConfigService) { }

  async execute(toolName: string, args: string, businessId: string): Promise<string> {
    this.logger.log(`Executing tool=${toolName} business_id=${businessId} args=${args}`);

    switch (toolName) {
      case 'stock_check':
        return this.executeStockCheck(args, businessId);
      case 'order_lookup':
        return this.executeOrderLookup(args, businessId);
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

function parseArgs(args: string): { query?: string; order_id?: string } | null {
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}
