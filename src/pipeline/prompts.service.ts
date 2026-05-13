import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface CachedPrompts {
  triage: string;
  generator: string;
  validator: string;
}

export interface BusinessContext {
  business_name?: string;
  industry?: string;
  product_catalog?: unknown;
  locations?: unknown;
  hours?: unknown;
  delivery_policy?: unknown;
  payment_methods?: unknown;
  current_offers?: unknown;
  brand_voice?: unknown;
  high_value_threshold_npr?: number;
  timezone?: string;
  channels?: unknown;
  size_chart_url?: string;
  size_guidance?: unknown;
  cod_policy?: unknown;
  return_and_exchange_policy?: unknown;
  loyalty_program?: unknown;
  emi_options?: unknown;
  [key: string]: unknown;
}

@Injectable()
export class PromptsService implements OnModuleInit {
  private readonly logger = new Logger(PromptsService.name);
  private cached: CachedPrompts | null = null;
  private readonly kbCache = new Map<string, BusinessContext & Record<string, unknown>>();

  private readonly PROMPT_DIR = join(__dirname, 'prompts');
  private readonly KB_DIR = join(__dirname, 'kb');

  async onModuleInit(): Promise<void> {
    try {
      await this.loadAll();
      this.logger.log(`Pipeline prompts warmed from ${this.PROMPT_DIR}`);
    } catch (e) {
      this.logger.error(`Failed to warm prompts: ${(e as Error).message}`);
      throw e;
    }
  }

  private async loadAll(): Promise<CachedPrompts> {
    if (this.cached) return this.cached;
    const [triage, generator, validator] = await Promise.all([
      readFile(join(this.PROMPT_DIR, '01_triage.md'), 'utf-8'),
      readFile(join(this.PROMPT_DIR, '02_generator.md'), 'utf-8'),
      readFile(join(this.PROMPT_DIR, '03_validator.md'), 'utf-8'),
    ]);
    this.cached = { triage, generator, validator };
    return this.cached;
  }

  private async loadKb(kbFileName: string): Promise<BusinessContext & Record<string, unknown>> {
    const cached = this.kbCache.get(kbFileName);
    if (cached) return cached;
    const raw = await readFile(join(this.KB_DIR, kbFileName), 'utf-8');
    const kb = JSON.parse(raw) as BusinessContext & Record<string, unknown>;
    this.kbCache.set(kbFileName, kb);
    return kb;
  }

  private substitute(template: string, kb: BusinessContext): string {
    return template.replaceAll('{{BUSINESS_NAME}}', kb.business_name || 'the business');
  }

  async getTriagePrompt(kbFileName: string): Promise<string> {
    const { triage } = await this.loadAll();
    const kb = await this.loadKb(kbFileName);
    return this.substitute(triage, kb);
  }

  async getGeneratorPrompt(kbFileName: string): Promise<string> {
    const { generator } = await this.loadAll();
    const kb = await this.loadKb(kbFileName);
    return this.substitute(generator, kb);
  }

  async getValidatorPrompt(): Promise<string> {
    const { validator } = await this.loadAll();
    return validator;
  }

  async getBusinessContext(kbFileName: string): Promise<BusinessContext> {
    const kb = await this.loadKb(kbFileName);
    return {
      business_name: kb.business_name,
      industry: kb.industry,
      product_catalog: kb.product_catalog,
      locations: kb.locations,
      hours: kb.hours,
      delivery_policy: kb.delivery_policy,
      payment_methods: kb.payment_methods,
      current_offers: kb.current_offers,
      brand_voice: kb.brand_voice,
      high_value_threshold_npr: kb.high_value_threshold_npr as number | undefined,
      timezone: kb.timezone as string | undefined,
      channels: kb.channels,
      size_chart_url: kb.size_chart_url as string | undefined,
      size_guidance: kb.size_guidance,
      cod_policy: kb.cod_policy,
      return_and_exchange_policy: kb.return_and_exchange_policy,
      loyalty_program: kb.loyalty_program,
      emi_options: kb.emi_options,
    };
  }
}
