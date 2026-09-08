import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  ArgumentsHost,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

// Captures what the filter writes to the HTTP response.
function runFilter(exception: unknown): { status: number; body: Record<string, unknown> } {
  const filter = new AllExceptionsFilter();
  let capturedStatus = 0;
  let capturedBody: Record<string, unknown> = {};
  const res = {
    status(s: number) {
      capturedStatus = s;
      return this;
    },
    json(b: Record<string, unknown>) {
      capturedBody = b;
      return this;
    },
  };
  const req = { method: 'POST', url: '/ai/v1/reply' };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;

  filter.catch(exception, host);
  return { status: capturedStatus, body: capturedBody };
}

describe('AllExceptionsFilter — 5xx internals are not leaked (C3)', () => {
  it('masks a 5xx HttpException message with a generic client message', () => {
    const { status, body } = runFilter(
      new InternalServerErrorException('connect ECONNREFUSED 10.0.0.5:5432'),
    );
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('masks other 5xx HttpExceptions (503) too', () => {
    const { body } = runFilter(new ServiceUnavailableException('upstream main-backend timeout'));
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('timeout');
  });

  it('still surfaces 4xx client messages verbatim', () => {
    const { status, body } = runFilter(new NotFoundException('business_not_found'));
    expect(status).toBe(404);
    expect(body.message).toBe('business_not_found');
  });

  it('still surfaces ValidationPipe 400 errors array', () => {
    const { status, body } = runFilter(
      new BadRequestException({ message: ['name must be a string'], error: 'Bad Request' }),
    );
    expect(status).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.errors).toEqual(['name must be a string']);
  });

  it('masks a plain Error as internal server error', () => {
    const { status, body } = runFilter(new TypeError('cannot read property x of undefined'));
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('undefined');
  });
});
