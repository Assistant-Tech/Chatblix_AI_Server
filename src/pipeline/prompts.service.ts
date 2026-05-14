import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface CachedPrompts {
  triage: string;
  generator: string;
  validator: string;
}

/**
 * Loads the legacy stage instruction markdown files. These still contain
 * Nepal-specific persona / tone content — Task 2.2a will split that out
 * into BusinessProfile fields. Until then we just substitute the business
 * name and ship the rest verbatim.
 */
@Injectable()
export class PromptsService implements OnModuleInit {
  private readonly logger = new Logger(PromptsService.name);
  private cached: CachedPrompts | null = null;

  private readonly PROMPT_DIR = join(__dirname, 'prompts');

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

  private substitute(template: string, businessName: string): string {
    return template.replaceAll('{{BUSINESS_NAME}}', businessName || 'the business');
  }

  async getTriagePrompt(businessName: string): Promise<string> {
    const { triage } = await this.loadAll();
    return this.substitute(triage, businessName);
  }

  async getGeneratorPrompt(businessName: string): Promise<string> {
    const { generator } = await this.loadAll();
    return this.substitute(generator, businessName);
  }

  async getValidatorPrompt(): Promise<string> {
    const { validator } = await this.loadAll();
    return validator;
  }
}
