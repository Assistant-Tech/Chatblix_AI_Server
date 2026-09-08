import { OpenRouterClient, OpenRouterError } from './openrouter.client';

function makeClient(): OpenRouterClient {
  return new OpenRouterClient({ openrouterKey: () => 'test-key' } as any);
}

// A 200 response whose body is not valid JSON.
function nonJsonOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<html>gateway</html>',
  } as unknown as Response;
}

function jsonOkResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe('OpenRouterClient.chatJson body handling (W4/W5)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('wraps a non-JSON 200 body in a typed OpenRouterError instead of a raw SyntaxError', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(nonJsonOkResponse());
    const client = makeClient();

    const err = await client.chatJson({ model: 'm', system: 's', user: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect((err as OpenRouterError).kind).toBe('api_error');
    expect((err as OpenRouterError).status).toBe(200);
    expect((err as Error).message).toMatch(/non-JSON/i);
  });

  it('parses a well-formed body and returns text + usage', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonOkResponse({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const client = makeClient();

    const res = await client.chatJson({ model: 'm', system: 's', user: 'u' });
    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: null });
  });
});
