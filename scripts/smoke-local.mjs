import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';

const apiKey = `smoke-${randomUUID()}-secret`;
const dataDir = await mkdtemp(join(tmpdir(), 'tavernnext-smoke-'));
const databasePath = join(dataDir, 'tavernnext.sqlite');
const providerRequests = [];
const logs = [];
let app;
let provider;
const originalFetch = globalThis.fetch;
const outboundUrls = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Local smoke failed: ${message}`);
}

async function closeHttpServer(server) {
  if (server === undefined) return;
  server.closeAllConnections();
  await new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
}

async function inject(method, url, payload) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  assert(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url} returned ${response.statusCode}: ${response.payload}`);
  return response;
}

try {
  provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    providerRequests.push({
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('data: {"choices":[{"delta":{"content":"Local smoke reply"}}]}\n\n');
    response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolveListen);
  });
  const providerAddress = provider.address();
  assert(providerAddress !== null && typeof providerAddress !== 'string', 'mock provider did not bind to TCP');
  const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    outboundUrls.push(url);
    return originalFetch(input, init);
  };

  app = createApp({
    config: { host: '127.0.0.1', port: 0, dataDir, databasePath },
    loggerStream: { write(message) { logs.push(message); } },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address !== null && typeof address !== 'string' && address.address === '127.0.0.1', 'server did not bind only to 127.0.0.1');

  const characterId = randomUUID();
  const personaId = randomUUID();
  const providerId = randomUUID();
  const presetId = randomUUID();
  const conversationId = randomUUID();
  await inject('POST', '/api/characters', {
    id: characterId,
    name: 'Smoke Aster',
    description: 'Local smoke character',
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    tags: [],
  });
  await inject('POST', '/api/personas', {
    id: personaId, name: 'Smoke Traveler', description: '', isDefault: true,
  });
  const providerResponse = await inject('POST', '/api/providers', {
    id: providerId,
    name: 'Smoke provider',
    baseUrl: providerBaseUrl,
    model: 'mock-model',
    apiMode: 'chat',
    apiKey,
  });
  await inject('POST', '/api/presets', {
    id: presetId,
    name: 'Smoke chat preset',
    kind: 'chat',
    settings: {
      tokenizer: 0,
      max_tokens: 64,
      prompts: [{ identifier: 'main', role: 'system', content: 'Local smoke prompt', enabled: true }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
    },
  });
  await inject('PATCH', '/api/settings/generation', {
    revision: 0,
    patch: { providerId, chatPresetId: presetId },
  });
  await inject('POST', '/api/conversations', {
    id: conversationId,
    characterId,
    personaId,
    title: 'Local smoke chat',
    maxPromptTokens: 8_192,
    maxResponseTokens: 64,
  });
  const generation = await inject('POST', `/api/conversations/${conversationId}/generations`, {
    conversationRevision: 0,
    mode: 'normal',
    userText: 'Run local smoke',
  });
  assert(generation.payload.includes('Local smoke reply') && generation.payload.includes('event: completed'), 'generation did not stream to completion');

  const providerList = await inject('GET', '/api/providers');
  const exposed = `${providerResponse.payload}\n${providerList.payload}\n${generation.payload}`;
  const logged = logs.join('');
  const database = await readFile(databasePath);
  assert(!exposed.includes(apiKey), 'API response exposed the configured API key');
  assert(!logged.includes(apiKey), 'captured server logs exposed the configured API key');
  assert(!database.includes(Buffer.from(apiKey)), 'SQLite database contains the configured API key');
  assert(providerRequests.length === 1, `expected one provider request, received ${providerRequests.length}`);
  assert(providerRequests[0].path === '/v1/chat/completions', `unexpected provider path ${providerRequests[0].path}`);
  assert(providerRequests[0].authorization === `Bearer ${apiKey}`, 'provider request did not use the configured key');
  const expectedOrigin = new URL(providerBaseUrl).origin;
  assert(outboundUrls.length === 1 && new URL(outboundUrls[0]).origin === expectedOrigin, `unexpected outbound calls: ${outboundUrls.join(', ')}`);

  console.log(`Local smoke: bound ${address.address}:${address.port}`);
  console.log(`Local smoke: ${providerRequests.length} configured-provider request, 0 telemetry requests`);
  console.log('Local smoke: API key absent from API responses, SQLite, and captured logs');
} finally {
  globalThis.fetch = originalFetch;
  if (app !== undefined) await app.close();
  await closeHttpServer(provider);
  await rm(dataDir, { recursive: true, force: true });
}
