import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReplyService } from './reply.service';
import { ReplyRequestDto, ReplyResponse } from '../common/types/reply.dto';

@ApiTags('reply')
@Controller('reply')
export class ReplyController {
  constructor(private readonly reply: ReplyService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the pipeline and return a final reply (or escalation / outside_hours).',
    description:
      'Workhorse endpoint — non-streaming JSON. Used by main backend for channel-driven traffic.',
  })
  @ApiResponse({ status: 200, description: 'ReplyResponse (replied | escalate | outside_hours)' })
  @ApiResponse({ status: 401, description: 'Missing or invalid INTERNAL_API_TOKEN' })
  @ApiResponse({ status: 404, description: 'Unknown business_id' })
  @ApiResponse({ status: 422, description: 'Malformed request body' })
  async create(@Body() body: ReplyRequestDto): Promise<ReplyResponse> {
    return this.reply.handle(body);
  }

  @Post('stream')
  @ApiOperation({
    summary: 'Streaming reply via Server-Sent Events. Used by web widgets only.',
    description:
      'Same input as POST /reply, but yields `token` events as the model produces partial output, then a final `done` event with the full ReplyResponse.',
  })
  async stream(@Body() body: ReplyRequestDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.reply.stream(body)) {
        writeSseEvent(res, chunk.type, chunk);
      }
    } catch (e) {
      writeSseEvent(res, 'error', { message: (e as Error).message });
    } finally {
      res.end();
    }
  }
}

function writeSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
