import { Injectable, Logger } from '@nestjs/common';
import { GeneratorService } from '../pipeline/generator.service';
import { MetricsService } from '../pipeline/metrics.service';
import type { AiDigestJobResult, DigestRequestDto, DigestStats } from '../common/types/digest.dto';

/** Owner-facing bullets, matching what the prompt is told to produce. */
const MAX_ATTENTION_ITEMS = 5;

/**
 * Entry point for the `ai.digest` queue — the digest counterpart to
 * ReplyService.
 *
 * Deliberately much thinner than the reply path. Triage and the validator are
 * skipped: triage classifies a customer's intent (there is no customer here),
 * and the validator enforces customer-facing reply rules — tone, price recap,
 * closing-flow discipline — none of which apply to an internal status note. The
 * safety machinery that protects a buyer from a bad reply has nothing to protect
 * against when the reader is the business owner and the input is a row of
 * counters.
 *
 * There is also no ContextLoader call: the digest needs no business profile, no
 * compiled system prompt and no conversation history, so it never touches the
 * profile cache or its HTTP fallback.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly generator: GeneratorService,
    private readonly metrics: MetricsService,
  ) {}

  async handle(req: DigestRequestDto): Promise<AiDigestJobResult> {
    const start = Date.now();
    const traceId = req.options?.trace_id ?? null;
    this.metrics.bump('digest_total');

    try {
      const generated = await this.generator.generateDigest(req);

      this.logger.log(
        `digest generated business_id=${req.business_id} trace_id=${traceId ?? '-'} window_hours=${req.window.hours} items=${generated.attentionItems.length} duration_ms=${Date.now() - start}`,
      );

      return {
        summary: generated.summary,
        attentionItems: generated.attentionItems.slice(0, MAX_ATTENTION_ITEMS),
        meta: {
          model: generated.model,
          tokensIn: generated.tokensIn,
          tokensOut: generated.tokensOut,
          durationMs: Date.now() - start,
          traceId,
          fallbackUsed: false,
        },
      };
    } catch (e) {
      const err = e as Error;
      // A digest is a nice-to-have, and the stats it summarises are already
      // computed and correct. Shipping a deterministic summary beats failing the
      // job and leaving the owner with a hole in their history — and unlike the
      // reply path, nothing here reaches a customer, so a plain-numbers fallback
      // is a perfectly acceptable digest.
      this.logger.warn(
        `digest generation fell back to stats-only business_id=${req.business_id} trace_id=${traceId ?? '-'}: ${err.message}`,
      );
      this.metrics.bump('digest_fallback_used');

      const fallback = buildFallbackDigest(req);
      return {
        summary: fallback.summary,
        attentionItems: fallback.attentionItems,
        meta: {
          model: null,
          tokensIn: null,
          tokensOut: null,
          durationMs: Date.now() - start,
          traceId,
          fallbackUsed: true,
        },
      };
    }
  }
}

/**
 * Deterministic digest built straight from the stats — no LLM involved. Used
 * when generation fails or returns nothing parseable. Reads plainly rather than
 * pretending to be the narrative version.
 */
export function buildFallbackDigest(req: DigestRequestDto): { summary: string; attentionItems: string[] } {
  const stats = req.stats;
  const { conversations, handling, captured, backlog } = stats;
  const windowLabel = req.window.hours <= 1 ? 'the last hour' : `the last ${req.window.hours} hours`;

  const sentences = [
    `${conversations.active} conversation${conversations.active === 1 ? '' : 's'} were active in ${windowLabel}: ` +
      `${handling.aiHandled} handled by the AI and ${handling.humanHandled} by your team.`,
  ];

  if (captured.orders > 0 || captured.leads > 0) {
    const parts: string[] = [];
    if (captured.orders > 0) parts.push(`${captured.orders} order${captured.orders === 1 ? '' : 's'} (total ${captured.orderValue})`);
    if (captured.leads > 0) parts.push(`${captured.leads} lead${captured.leads === 1 ? '' : 's'}`);
    sentences.push(`Captured: ${parts.join(' and ')}.`);
  }

  if (handling.handoffs > 0) {
    sentences.push(`${handling.handoffs} conversation${handling.handoffs === 1 ? ' was' : 's were'} handed to a human.`);
  }

  return {
    summary: sentences.join(' '),
    attentionItems: fallbackAttentionItems(stats),
  };
}

function fallbackAttentionItems(stats: DigestStats): string[] {
  const { backlog } = stats;
  const items: string[] = [];

  if (backlog.unassignedOverThreshold > 0) {
    items.push(
      `${backlog.unassignedOverThreshold} conversation${backlog.unassignedOverThreshold === 1 ? ' has' : 's have'} been unassigned for over ${backlog.unassignedThresholdMinutes} minutes.`,
    );
  }

  if (backlog.oldestUnresolvedHandoffMinutes !== null && backlog.oldestUnresolvedHandoffMinutes > 0) {
    items.push(`The oldest unresolved AI handoff has been waiting ${backlog.oldestUnresolvedHandoffMinutes} minutes.`);
  }

  for (const stuck of backlog.stuck) {
    if (items.length >= MAX_ATTENTION_ITEMS) break;
    const reason = stuck.reason ? ` — ${stuck.reason}` : '';
    items.push(`${stuck.title} has been waiting ${stuck.waitingMinutes} minutes on ${stuck.channel}${reason}`);
  }

  return items.slice(0, MAX_ATTENTION_ITEMS);
}
