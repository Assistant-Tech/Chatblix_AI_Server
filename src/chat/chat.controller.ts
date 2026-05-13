import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiProduces,
  ApiBody,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ChatStreamService } from './chat-stream.service';
import { ChatStreamRequestDto, ChatJsonResponseDto } from '../common/types/chat.dto';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly stream: ChatStreamService) {}

  @Post('stream')
  @ApiOperation({
    summary: 'Run one turn of the LLM pipeline and stream the reply as Server-Sent Events',
    description: `Returns a long-lived **text/event-stream** response with the following frame sequence:

| Order | Event | Payload | Notes |
|-------|-------|---------|-------|
| 1 | \`metadata\` | seed lead delta (score, stage, intent, tags) | Deterministic momentum from the user message. Always fires first. |
| 2 | \`triage\` | classified triage JSON (language, intent_path, extracted_data_delta, closing_state, ...) | Stage 1 output. |
| 3+ | \`token\` | \`{ content: string }\` (one per delta) | Streamed reply text from the generator. |
| ? | \`regenerate\` | \`{ reason, attempt, violations }\` | Only on validator-driven retry; the client should reset its bubble. |
| n-2 | \`verdict\` | \`{ pass, outcome, violations }\` | Final validator verdict (or soft-pass on validator error). |
| n-1 | \`metadata\` | final lead delta (post-momentum recompute) | Optional; only if the diff is non-empty. |
| n | \`done\` | \`{ reply, metadata, raw }\` | Terminal event. The client should close the connection. |

On any unrecoverable error an \`error\` frame is sent and the stream ends.`,
  })
  @ApiBody({ type: ChatStreamRequestDto })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'Server-sent event stream. See the description for the event sequence.',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: metadata\\ndata: {"lead_score":12,"stage":"cold","intent":"inquiry"}\\n\\n' +
            'event: triage\\ndata: {"language":{"detected":"romanized_ne"},"intent_path":"named_product_price_ask"}\\n\\n' +
            'event: token\\ndata: {"content":"Hajur, "}\\n\\n' +
            'event: verdict\\ndata: {"pass":true,"outcome":"pass_first_try","violations":[]}\\n\\n' +
            'event: done\\ndata: {"reply":"Hajur, face mask ko price NPR 950 ho.","metadata":{...},"raw":"<reply>...</reply><metadata>...</metadata>"}\\n\\n',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation failed (missing or invalid `session_id` / `message`).' })
  async streamChat(
    @Body() body: ChatStreamRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': ok\n\n');

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const send = (event: string, data: unknown): void => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const evt of this.stream.runStream(body)) {
        if (closed) return;
        send(evt.event, evt.data);
      }
    } catch (e) {
      if (!closed) send('error', { error: (e as Error).message || 'stream failed' });
    } finally {
      if (!closed) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  }

  @Post()
  @ApiOperation({
    summary: 'Run one turn of the LLM pipeline and return the final reply as JSON',
    description:
      "Convenience wrapper around `/api/chat/stream` that drains all SSE frames internally and returns the terminal `done` payload as JSON. Use this when you don't need progressive streaming.",
  })
  @ApiBody({ type: ChatStreamRequestDto })
  @ApiResponse({
    status: 201,
    description: 'Final reply, metadata, and raw generator output.',
    type: ChatJsonResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  async chatJson(@Body() body: ChatStreamRequestDto): Promise<ChatJsonResponseDto> {
    return this.stream.runOnce(body);
  }
}
