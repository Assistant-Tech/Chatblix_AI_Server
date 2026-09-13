import { PromptsService } from './prompts.service';

// Reads the real prompt file from src/pipeline/prompts, the same way the service
// does at boot, so a renamed file or a broken placeholder fails here.
describe('PromptsService.getAssistantPrompt', () => {
  it('loads 05_assistant.md with the business name substituted', async () => {
    const prompt = await new PromptsService().getAssistantPrompt('Himalayan Skincare');

    expect(prompt).toContain('# MODEL 5 — DIGEST ASSISTANT');
    expect(prompt).toContain('`Himalayan Skincare`');
    expect(prompt).not.toContain('{{BUSINESS_NAME}}');
  });

  it('carries the rules the assistant is built around', async () => {
    const prompt = await new PromptsService().getAssistantPrompt('X');

    expect(prompt).toMatch(/THREE CLOCKS/);
    expect(prompt).toMatch(/UNTRUSTED TEXT/);
    expect(prompt).toMatch(/READ-ONLY/);
    expect(prompt).toMatch(/No markdown headings, bold, italics, tables, links, images, HTML, code fences or emoji/);
    for (const tool of ['get_digest', 'list_conversations', 'get_conversation', 'list_orders', 'list_leads', 'get_period_stats']) {
      expect(prompt).toContain(`\`${tool}\``);
    }
  });
});
