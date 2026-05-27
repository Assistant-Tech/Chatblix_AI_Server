import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorShape {
  status: number;
  clientMessage: string;
  logMessage: string;
  errors?: string[];
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    // Only handle HTTP — BullMQ and WebSocket contexts have their own error handling
    if (host.getType() !== 'http') return;

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const { status, clientMessage, logMessage, errors } = this.extractError(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;
    const prefix = `${req.method} ${req.url} → ${status}`;

    if (status >= 500) {
      this.logger.error(`${prefix}: ${logMessage}`, stack);
    } else {
      this.logger.warn(`${prefix}: ${logMessage}`);
    }

    const body: Record<string, unknown> = {
      statusCode: status,
      message: clientMessage,
      path: req.url,
      timestamp: new Date().toISOString(),
    };
    if (errors?.length) body.errors = errors;

    res.status(status).json(body);
  }

  private extractError(exception: unknown): ErrorShape {
    // ── HttpException (NotFoundException, BadRequestException, etc.) ──────────
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const name = exception.constructor.name;
      const response = exception.getResponse();

      if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;

        // ValidationPipe produces { message: string[], error: 'Bad Request' }
        if (Array.isArray(r.message)) {
          const errors = r.message as string[];
          return {
            status,
            clientMessage: 'Validation failed',
            logMessage: `[${name}] ${errors.join('; ')}`,
            errors,
          };
        }

        const detail =
          typeof r.message === 'string' ? r.message : exception.message;
        return {
          status,
          clientMessage: detail,
          logMessage: `[${name}] ${detail}`,
        };
      }

      // Plain string response
      const detail =
        typeof response === 'string' ? response : exception.message;
      return {
        status,
        clientMessage: detail,
        logMessage: `[${name}] ${detail}`,
      };
    }

    // ── Standard Error (TypeError, ReferenceError, custom errors, etc.) ───────
    if (exception instanceof Error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        clientMessage: 'Internal server error',
        logMessage: `[${exception.constructor.name}] ${exception.message}`,
      };
    }

    // ── Non-Error thrown value (throw 'string', throw 42, etc.) ───────────────
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      clientMessage: 'Internal server error',
      logMessage: `[UnknownException] ${String(exception)}`,
    };
  }
}
