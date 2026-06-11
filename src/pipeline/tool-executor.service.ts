import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly config: AppConfigService) { }

  async execute(toolName: string, args: string, businessId: string): Promise<string> {
    this.logger.log(`Executing tool=${toolName} business_id=${businessId} args=${args}`);

    if (toolName === 'stock_check') {
      return this.executeStockCheck(args, businessId);
    }

    this.logger.warn(`Unknown tool: ${toolName}`);
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  private async executeStockCheck(args: string, businessId: string): Promise<string> {
    try {
      let parsedArgs: { query?: string };
      try {
        parsedArgs = JSON.parse(args);
      } catch (e) {
        return JSON.stringify({ error: 'Invalid JSON arguments' });
      }

      if (!parsedArgs.query) {
        return JSON.stringify({ error: 'Missing required argument: query' });
      }

      const url = `${this.config.mainBackendInternalUrl()}/api/v1/internal/ai/tools/stock-check`;
      const token = this.config.mainBackendInternalToken();

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          tenantId: businessId,
          query: parsedArgs.query,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        this.logger.error(`Stock check failed status=${response.status} response=${errText}`);
        return JSON.stringify({ error: 'Internal API error during stock check' });
      }

      const data = await response.json();
      return JSON.stringify(data);
    } catch (e) {
      this.logger.error(`Error executing stock_check: ${(e as Error).message}`);
      return JSON.stringify({ error: 'Failed to execute stock check due to network or parsing error' });
    }
  }
}
