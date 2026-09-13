import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  ASSISTANT_TOOL_PATHS,
  CHANNELS,
  CONVERSATION_FILTERS,
  LIST_LIMIT,
  MESSAGE_LIMIT,
  ORDER_STATUSES,
  PERIOD_METRICS,
  PERIODS,
} from './assistant-tools.registry';

// Same contract as the reply path's ToolExecutorService.callInternalTool: a hard
// timeout, never throws, always hands the model a well-formed result. It is a
// separate class on purpose — the customer executor hardcodes
// /internal/ai/tools/ and knows none of these names; this one knows only these.

const TOOL_FETCH_TIMEOUT_MS = 5000;
/** Largest single tool result handed back to the model. */
export const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_NAME_FILTER_CHARS = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side context. Never visible to, or settable by, the model. */
export interface AssistantToolContext {
  tenantId: string;
  digestId: string;
}

export interface AssistantToolResult {
  /** The tool message content for the model. Always a string. */
  content: string;
  /** False on any failure, including a tool that answered `{ error }`. */
  ok: boolean;
  error: string | null;
  /** The arguments actually sent (the model's, whitelisted and clamped), for the audit. */
  args: Record<string, unknown> | null;
  durationMs: number;
}

type Bounds = { min: number; max: number; default: number };
type Built = { args: Record<string, unknown>; body: Record<string, unknown> } | { error: string };

@Injectable()
export class AssistantToolExecutorService {
  private readonly logger = new Logger(AssistantToolExecutorService.name);

  constructor(private readonly config: AppConfigService) {}

  async execute(name: string, rawArgs: string, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const started = Date.now();
    // Never log arguments: a name filter is a customer's name.
    this.logger.log(`Executing assistant tool=${name} business_id=${ctx.tenantId}`);

    const path = Object.prototype.hasOwnProperty.call(ASSISTANT_TOOL_PATHS, name) ? ASSISTANT_TOOL_PATHS[name] : undefined;
    if (!path) {
      this.logger.warn(`Unknown assistant tool: ${name}`);
      return failure(`Unknown tool: ${name}`, null, started);
    }

    const parsed = parseArgs(rawArgs);
    if (!parsed) return failure('Invalid JSON arguments', null, started);

    const built = buildRequest(name, parsed);
    if ('error' in built) return failure(built.error, null, started);

    // The context goes in last and the model's arguments were whitelisted above,
    // so a `tenantId` or `business_id` the model tried to pass never survives.
    const body = { ...built.body, tenantId: ctx.tenantId, digestId: ctx.digestId };
    return this.postInternal(name, path, body, built.args, started);
  }

  private async postInternal(
    name: string,
    path: string,
    body: Record<string, unknown>,
    args: Record<string, unknown>,
    started: number,
  ): Promise<AssistantToolResult> {
    const url = `${this.config.mainBackendInternalUrl()}/api/v1/internal/ai/assistant/${path}`;
    const controller = new AbortController();
    // Armed through the body read too, so a stalled body can't hang the turn.
    const timer = setTimeout(() => controller.abort(), TOOL_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.mainBackendInternalToken()}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        this.logger.error(`assistant tool=${name} failed status=${response.status} response=${errText.slice(0, 200)}`);
        return failure(`Internal API error during ${name}`, args, started, `http_${response.status}`);
      }

      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return failure(`${name} returned an unreadable result`, args, started);
      }

      const toolError = typeof (payload as { error?: unknown } | null)?.error === 'string' ? (payload as { error: string }).error : null;
      return { content: truncate(text), ok: toolError === null, error: toolError, args, durationMs: Date.now() - started };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        this.logger.error(`assistant tool=${name} timed out after ${TOOL_FETCH_TIMEOUT_MS}ms`);
        return failure(`${name} timed out`, args, started);
      }
      this.logger.error(`assistant tool=${name} failed: ${err?.message}`);
      return failure(`Failed to execute ${name} due to a network error`, args, started);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Argument whitelisting ────────────────────────────────────────────────────
//
// Each tool copies only the arguments it declares, coerces and clamps them, and
// maps them to main-backend's camelCase body. `args` (the model's names) is what
// the audit records; `body` is what is sent.

function buildRequest(name: string, a: Record<string, unknown>): Built {
  switch (name) {
    case 'get_digest': {
      const which = a.which ?? 'current';
      if (which !== 'current' && which !== 'previous') return { error: 'which must be "current" or "previous"' };
      return { args: { which }, body: { which } };
    }

    case 'list_conversations': {
      if (!isOneOf(CONVERSATION_FILTERS, a.filter)) return { error: `filter must be one of: ${CONVERSATION_FILTERS.join(', ')}` };
      const limit = clamp(a.limit, LIST_LIMIT);
      const args: Record<string, unknown> = { filter: a.filter, limit };
      const body: Record<string, unknown> = { filter: a.filter, limit };

      if (a.channel !== undefined && a.channel !== null && a.channel !== '') {
        const channel = typeof a.channel === 'string' ? a.channel.trim().toUpperCase() : '';
        if (!isOneOf(CHANNELS, channel)) return { error: `channel must be one of: ${CHANNELS.join(', ')}` };
        args.channel = body.channel = channel;
      }
      if (typeof a.name_contains === 'string' && a.name_contains.trim()) {
        const nameContains = a.name_contains.trim().slice(0, MAX_NAME_FILTER_CHARS);
        args.name_contains = nameContains;
        body.nameContains = nameContains;
      }
      return { args, body };
    }

    case 'get_conversation': {
      const id = typeof a.conversation_id === 'string' ? a.conversation_id.trim() : '';
      if (!UUID_RE.test(id)) return { error: 'conversation_id must be a conversation id from list_conversations or the digest' };
      const messageLimit = clamp(a.message_limit, MESSAGE_LIMIT);
      return { args: { conversation_id: id, message_limit: messageLimit }, body: { conversationId: id, messageLimit } };
    }

    case 'list_orders': {
      const limit = clamp(a.limit, LIST_LIMIT);
      const args: Record<string, unknown> = { limit };
      const body: Record<string, unknown> = { limit };
      if (a.status !== undefined && a.status !== null && a.status !== '') {
        const status = typeof a.status === 'string' ? a.status.trim().toUpperCase() : '';
        if (!isOneOf(ORDER_STATUSES, status)) return { error: `status must be one of: ${ORDER_STATUSES.join(', ')}` };
        args.status = body.status = status;
      }
      return { args, body };
    }

    case 'list_leads': {
      const limit = clamp(a.limit, LIST_LIMIT);
      return { args: { limit }, body: { limit } };
    }

    case 'get_period_stats': {
      if (!isOneOf(PERIOD_METRICS, a.metric)) return { error: `metric must be one of: ${PERIOD_METRICS.join(', ')}` };
      const period = a.period ?? '7d';
      if (!isOneOf(PERIODS, period)) return { error: `period must be one of: ${PERIODS.join(', ')}` };
      return { args: { metric: a.metric, period }, body: { metric: a.metric, period } };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/** Empty arguments are `{}`; non-object JSON is treated as no arguments; unparseable is null. */
function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function clamp(value: unknown, bounds: Bounds): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(n)));
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: the result was longer than ${MAX_TOOL_RESULT_CHARS} characters]`;
}

function failure(message: string, args: Record<string, unknown> | null, started: number, code?: string): AssistantToolResult {
  const content = JSON.stringify({ error: message });
  return { content, ok: false, error: code ?? message, args, durationMs: Date.now() - started };
}
