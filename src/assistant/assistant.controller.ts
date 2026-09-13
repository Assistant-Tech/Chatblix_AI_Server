import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AssistantService } from './assistant.service';
import { AssistantStreamRequestDto } from './assistant-request.dto';

/**
 * POST /ai/v1/assistant/stream — one digest-assistant turn as Server-Sent Events.
 * Called only by main-backend's AiAssistantStreamService; the global
 * InternalTokenGuard covers it. A bad body is a 400 from the ValidationPipe,
 * before any SSE header is written.
 */
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('stream')
  async stream(@Body() body: AssistantStreamRequestDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    // no-transform: nothing between here and the browser may buffer or compress the stream.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // The request's 'close' fires as soon as its body has been read, so it can't
    // signal a disconnect. The response closing before we ended it does.
    const disconnect = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) disconnect.abort();
    });

    await this.assistant.stream(body, res, disconnect.signal);
  }
}
