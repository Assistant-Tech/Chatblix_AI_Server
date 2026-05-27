import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SandboxService } from './sandbox.service';
import { SandboxRequestDto } from './sandbox-request.dto';

@Controller('sandbox')
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Post('stream')
  async stream(@Body() body: SandboxRequestDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    await this.sandbox.stream(body, res);
  }
}
