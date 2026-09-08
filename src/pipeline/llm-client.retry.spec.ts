import { LLMClientService } from './llm-client.service';
import { OpenRouterError } from './openrouter.client';

// Drives withRetry via chatJson by controlling what the upstream throws.
function makeClient(upstreamBehaviour: () => Promise<any>) {
  const upstream = { chatJson: jest.fn(upstreamBehaviour) } as any;
  const svc = new LLMClientService(upstream);
  return { svc, upstream };
}

describe('LLMClientService.chatJson retry policy (W3)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does NOT retry a 4xx (e.g. 400 bad model) — one attempt only', async () => {
    const { svc, upstream } = makeClient(async () => {
      throw new OpenRouterError('bad model', 'api_error', 400);
    });
    await expect(svc.chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow();
    expect(upstream.chatJson).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 401 (bad key)', async () => {
    const { svc, upstream } = makeClient(async () => {
      throw new OpenRouterError('unauthorized', 'api_error', 401);
    });
    await expect(svc.chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow();
    expect(upstream.chatJson).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a genuine 5xx up to MAX_ATTEMPTS', async () => {
    const { svc, upstream } = makeClient(async () => {
      throw new OpenRouterError('upstream boom', 'api_error', 503);
    });
    await expect(svc.chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow();
    expect(upstream.chatJson).toHaveBeenCalledTimes(3);
  });

  it('DOES retry a 429 rate limit', async () => {
    const { svc, upstream } = makeClient(async () => {
      throw new OpenRouterError('slow down', 'api_error', 429);
    });
    await expect(svc.chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow();
    expect(upstream.chatJson).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-JSON 200 body (surfaced as api_error status 200)', async () => {
    const { svc, upstream } = makeClient(async () => {
      throw new OpenRouterError('OpenRouter returned non-JSON body', 'api_error', 200);
    });
    await expect(svc.chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow();
    expect(upstream.chatJson).toHaveBeenCalledTimes(1);
  });
});
