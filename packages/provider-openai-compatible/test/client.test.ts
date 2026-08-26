import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError, createOpenAICompatibleClient } from '../src/index.js';
import { beginSse, type MockServer, sendJson, startMockServer } from './mock-server.js';

const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function mock(handler: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const server = await startMockServer(handler);
  servers.push(server);
  return server;
}

function client(baseUrl: string, apiKey = 'test-api-key') {
  return createOpenAICompatibleClient({ baseUrl, apiKey });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe('OpenAI-compatible provider client', () => {
  it('normalizes a trailing /v1/ URL, lists models, and sends only profile credentials', async () => {
    const server = await mock((request, response) => {
      expect(request.method).toBe('GET');
      expect(request.path).toBe('/v1/models');
      expect(request.headers.authorization).toBe('Bearer test-api-key');
      expect(request.headers['x-untrusted']).toBeUndefined();
      sendJson(response, 200, { data: [{ id: 'mock', owned_by: 'local' }] });
    });

    await expect(client(`${server.baseUrl}/v1/`).listModels()).resolves.toEqual([
      { id: 'mock', ownedBy: 'local' },
    ]);
  });

  it('streams chat deltas, usage, and completion from SSE frames', async () => {
    const server = await mock((request, response) => {
      expect(request.path).toBe('/v1/chat/completions');
      expect(request.body).toMatchObject({ model: 'mock', messages: [{ role: 'user', content: 'Hi' }], stream: true });
      expect(request.body).not.toHaveProperty('max_tokens');
      expect(request.body).not.toHaveProperty('max_completion_tokens');
      beginSse(response);
      response.write(': keepalive\r\n');
      response.write('data: {"choices":[{"delta":{"reasoning_content":"Think"}}]}\r\n\r\n');
      response.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n');
      response.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      response.write('data: {"usage":{"prompt_tokens":4,\n');
      response.write('data: "completion_tokens":2}}\n\n');
      response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      response.end('data: [DONE]\n\n');
    });

    await expect(collect(client(`${server.baseUrl}/`).streamChat({
      model: 'mock', messages: [{ role: 'user', content: 'Hi' }],
    }))).resolves.toEqual([
      { type: 'reasoning_delta', text: 'Think' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'usage', inputTokens: 4, outputTokens: 2 },
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('streams text completions from the OpenAI /v1/completions endpoint', async () => {
    const server = await mock((request, response) => {
      expect(request.path).toBe('/v1/completions');
      expect(request.body).toEqual({ model: 'mock', prompt: 'Continue', stream: true });
      beginSse(response);
      response.write('data: {"choices":[{"text":"there","finish_reason":"stop"}]}\n\n');
      response.end('data: [DONE]\n\n');
    });

    await expect(collect(client(server.baseUrl).streamText({ model: 'mock', prompt: 'Continue' }))).resolves.toEqual([
      { type: 'delta', text: 'there' },
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('normalizes a non-stream JSON completion response', async () => {
    const server = await mock((_request, response) => {
      sendJson(response, 200, {
        choices: [{ message: { reasoning_content: 'Think', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    });

    await expect(collect(client(server.baseUrl).streamChat({
      model: 'mock', messages: [{ role: 'user', content: 'Hi' }],
    }))).resolves.toEqual([
      { type: 'reasoning_delta', text: 'Think' },
      { type: 'delta', text: 'Hello' },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('maps unauthorized responses without leaking API keys or response headers', async () => {
    const server = await mock((_request, response) => {
      sendJson(response, 401, { error: { message: 'invalid key test-api-key' } }, { 'x-secret': 'response-secret' });
    });

    await expect(client(server.baseUrl).listModels()).rejects.toMatchObject({ code: 'auth', status: 401 });
    await client(server.baseUrl).listModels().catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error)).not.toContain('test-api-key');
      expect(String(error)).not.toContain('response-secret');
    });
  });

  it('maps Chat authentication and rate limits through Pi without leaking secrets', async () => {
    const authServer = await mock((_request, response) => {
      sendJson(response, 401, { error: { message: 'invalid key chat-secret' } });
    });
    await expect(collect(client(authServer.baseUrl, 'chat-secret').streamChat({
      model: 'mock', messages: [],
    }))).rejects.toMatchObject({ code: 'auth', status: 401 });
    await collect(client(authServer.baseUrl, 'chat-secret').streamChat({ model: 'mock', messages: [] }))
      .catch((error: unknown) => expect(String(error)).not.toContain('chat-secret'));

    const rateServer = await mock((_request, response) => {
      sendJson(response, 429, { error: { message: 'slow down' } }, { 'retry-after': '3' });
    });
    await expect(collect(client(rateServer.baseUrl).streamChat({
      model: 'mock', messages: [],
    }))).rejects.toMatchObject({ code: 'rate_limit', status: 429, retryAfterMs: 3000 });
  });

  it('preserves custom Authorization headers when an API key is not configured', async () => {
    const server = await mock((request, response) => {
      expect(request.headers.authorization).toBe('Custom server credential');
      beginSse(response);
      response.end('data: [DONE]\n\n');
    });
    const custom = createOpenAICompatibleClient({
      baseUrl: server.baseUrl,
      headers: { Authorization: 'Custom server credential' },
    });

    await expect(collect(custom.streamChat({ model: 'mock', messages: [] }))).resolves.toEqual([
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('reports cached prompt tokens in the stable input-token total', async () => {
    const server = await mock((_request, response) => {
      beginSse(response);
      response.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4,"cache_write_tokens":2}}}\n\n');
      response.end('data: [DONE]\n\n');
    });

    await expect(collect(client(server.baseUrl).streamChat({ model: 'mock', messages: [] }))).resolves.toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 3 },
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('maps rate limiting with safe retry metadata', async () => {
    const server = await mock((_request, response) => {
      sendJson(response, 429, { error: { message: 'too many requests' } }, { 'retry-after': '2' });
    });

    await expect(client(server.baseUrl).listModels()).rejects.toMatchObject({
      code: 'rate_limit', status: 429, retryAfterMs: 2000,
    });
  });

  it('maps a refused connection to connection without exposing the endpoint', async () => {
    await expect(client('http://127.0.0.1:1').listModels()).rejects.toMatchObject({ code: 'connection' });
  });

  it('maps malformed SSE as a protocol error', async () => {
    const server = await mock((_request, response) => {
      beginSse(response);
      response.end('data: {not-json}\n\n');
    });

    await expect(collect(client(server.baseUrl).streamChat({ model: 'mock', messages: [] }))).rejects.toMatchObject({ code: 'protocol' });
  });

  it('maps a mid-stream disconnect to a connection error', async () => {
    const server = await mock((_request, response) => {
      beginSse(response);
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      response.socket?.destroy();
    });

    await expect(collect(client(server.baseUrl).streamChat({ model: 'mock', messages: [] }))).rejects.toMatchObject({ code: 'connection' });
  });

  it('maps provider context-limit responses', async () => {
    const server = await mock((_request, response) => {
      sendJson(response, 400, { error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } });
    });

    await expect(collect(client(server.baseUrl).streamChat({ model: 'mock', messages: [] }))).rejects.toMatchObject({
      code: 'context_overflow', status: 400,
    });
  });

  it('treats [DONE] as a completed response when no finish chunk was supplied', async () => {
    const server = await mock((_request, response) => {
      beginSse(response);
      response.end('data: [DONE]\n\n');
    });

    await expect(collect(client(server.baseUrl).streamChat({ model: 'mock', messages: [] }))).resolves.toEqual([
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('maps AbortSignal cancellation to aborted', async () => {
    const server = await mock((_request, response) => {
      beginSse(response);
      setTimeout(() => response.end('data: [DONE]\n\n'), 1000);
    });
    const controller = new AbortController();
    const events = client(server.baseUrl).streamChat({ model: 'mock', messages: [] }, controller.signal);
    const pending = collect(events);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });
});
