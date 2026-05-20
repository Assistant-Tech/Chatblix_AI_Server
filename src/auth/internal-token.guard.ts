import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { IS_PUBLIC_KEY } from './public.decorator';

const BEARER_PREFIX = /^Bearer\s+/i;

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const provided = header.replace(BEARER_PREFIX, '').trim();
    if (!provided) {
      throw new UnauthorizedException('missing internal token');
    }

    // One token covers both directions: same secret the cold-cache call sends
    // to main-backend and that any caller must send to reach ai-backend.
    const expected = this.config.mainBackendInternalToken();
    if (!safeEqual(provided, expected)) {
      throw new UnauthorizedException('invalid internal token');
    }
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
