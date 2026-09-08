import { NotFoundException } from '@nestjs/common';
import { MainBackendClient } from './main-backend.client';

function makeClient(): MainBackendClient {
  const config = {
    mainBackendInternalUrl: () => 'http://main-backend',
    mainBackendInternalToken: () => 'tok',
  } as any;
  return new MainBackendClient(config);
}

describe('MainBackendClient.getProfile — non-JSON body is terminal (W6)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does NOT retry when the 200 body is not JSON — single fetch, terminal error', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
      text: async () => '<html>502</html>',
    } as unknown as Response);

    const client = makeClient();
    const err = await client.getProfile('biz_1').catch((e) => e);

    expect((err as Error).message).toMatch(/non-JSON/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a genuine 5xx (network-ish) up to MAX_RETRIES + 1', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    } as unknown as Response);

    const client = makeClient();
    await client.getProfile('biz_1').catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 + MAX_RETRIES(2)
  });

  it('does not retry a 404', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    } as unknown as Response);

    const client = makeClient();
    await expect(client.getProfile('biz_1')).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the unwrapped profile on a { data: … } envelope', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { name: 'Acme' } }),
      text: async () => '',
    } as unknown as Response);

    const client = makeClient();
    const profile = await client.getProfile('biz_1');
    expect(profile).toEqual({ name: 'Acme' });
  });
});
