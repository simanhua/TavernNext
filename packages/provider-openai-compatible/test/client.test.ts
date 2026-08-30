import { ProviderError, createOpenAICompatibleClient } from '../src/index.js';
import { type MockServer, sendJson, startMockServer } from './mock-server.js';
import { afterEach, describe, expect, it } from 'vitest';

const servers: MockServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function mock(handler: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const server = await startMockServer(handler);
  servers.push(server);
  return server;
}

describe('Provider discovery client', () => {
  it('normalizes /v1, lists safe model metadata, and sends only the configured credential', async () => {
    const server = await mock((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.path).toBe('/v1/models');
      expect(request.headers.authorization).toBe('Bearer test-key');
      sendJson(response, 200, { data: [{ id: 'agent-model', owned_by: 'local' }] });
    });
    await expect(createOpenAICompatibleClient({
      baseUrl: `${server.baseUrl}/v1/`, apiKey: 'test-key',
    }).listModels()).resolves.toEqual([{ id: 'agent-model', ownedBy: 'local' }]);
  });

  it('maps discovery failures without returning response bodies, headers, or credentials', async () => {
    const server = await mock((_request, response) => {
      sendJson(response, 401, { error: { message: 'invalid secret-key' } }, { 'x-secret': 'header-secret' });
    });
    const client = createOpenAICompatibleClient({ baseUrl: server.baseUrl, apiKey: 'secret-key' });
    await client.listModels().catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'auth', status: 401 });
      expect(String(error)).not.toContain('secret-key');
      expect(String(error)).not.toContain('header-secret');
    });
  });

  it('maps rate limits and refused connections to stable safe errors', async () => {
    const server = await mock((_request, response) => {
      sendJson(response, 429, {}, { 'retry-after': '2' });
    });
    await expect(createOpenAICompatibleClient({ baseUrl: server.baseUrl }).listModels())
      .rejects.toMatchObject({ code: 'rate_limit', retryAfterMs: 2_000 });
    await expect(createOpenAICompatibleClient({ baseUrl: 'http://127.0.0.1:1' }).listModels())
      .rejects.toMatchObject({ code: 'connection' });
  });
});
