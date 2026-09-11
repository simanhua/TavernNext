import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { DESTINED_POEM_SCENE_ID } from '../apps/server/src/scenes/official-package.ts';

const apiKey = `smoke-${randomUUID()}-secret`;
const narrative = 'Local smoke reply';
const actionOptions = [
  { kind: 'smooth', text: 'Ask the guide about the reply.' },
  { kind: 'smooth', text: 'Pause and study the surroundings.' },
  { kind: 'engage', text: 'Discuss the next step with the guide.' },
  { kind: 'advance', text: 'Walk to the nearby town gate.' },
  { kind: 'mainline', text: 'Follow the clue described by the guide.' },
  { kind: 'twist', text: 'Investigate a sudden knock at the door.' },
  { kind: 'dark', text: 'Confront the suspicious traveler outside.' },
];
const dataDir = await mkdtemp(join(tmpdir(), 'tavernnext-smoke-'));
const databasePath = join(dataDir, 'tavernnext.sqlite');
const providerRequests = [];
const logs = [];
const apiResponses = [];
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
  apiResponses.push(response.payload);
  assert(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url} returned ${response.statusCode}: ${response.payload}`);
  return response;
}

try {
  provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const toolNames = (body.tools ?? []).map(({ function: tool }) => tool.name);
    const purpose = body.tool_choice?.function?.name === 'action_options_stage'
      && toolNames.length === 1 && toolNames[0] === 'action_options_stage'
      ? 'action-options'
      : toolNames.includes('save_state_read') && !toolNames.includes('action_options_stage')
        ? 'narrative'
        : 'unexpected';
    providerRequests.push({
      method: request.method,
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      authorization: request.headers.authorization,
      body,
      purpose,
    });
    const expectedPurpose = ['narrative', 'action-options'][providerRequests.length - 1];
    if (purpose !== expectedPurpose) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected_smoke_provider_request' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = purpose === 'action-options'
      ? { tool_calls: [{
          index: 0, id: 'smoke-action-options', type: 'function',
          function: { name: 'action_options_stage', arguments: JSON.stringify({ options: actionOptions }) },
        }] }
      : { content: narrative };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: purpose === 'action-options' ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolveListen);
  });
  const providerAddress = provider.address();
  assert(providerAddress !== null && typeof providerAddress !== 'string', 'mock provider did not bind to TCP');
  const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
  const expectedUrl = `${providerBaseUrl}/chat/completions`;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    outboundUrls.push(url);
    assert(url === expectedUrl, `unexpected outbound destination: ${url}`);
    return originalFetch(input, init);
  };

  app = createApp({
    config: { host: '127.0.0.1', port: 0, dataDir, databasePath },
    loggerStream: { write(message) { logs.push(message); } },
    // Keep this gate limited to the foreground narrative and Action Options calls.
    memoryWorkerIntervalMs: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address !== null && typeof address !== 'string' && address.address === '127.0.0.1', 'server did not bind only to 127.0.0.1');

  const providerId = randomUUID();
  const conversationId = randomUUID();
  await inject('POST', `/api/scenes/${DESTINED_POEM_SCENE_ID}/install`);
  await inject('POST', '/api/providers', {
    id: providerId,
    name: 'Smoke provider',
    baseUrl: providerBaseUrl,
    model: 'mock-model',
    apiMode: 'chat',
    toolCalls: true,
    apiKey,
  });
  await inject('PATCH', '/api/settings/generation', {
    revision: 0,
    patch: { providerId },
  });
  const conversationResponse = await inject('POST', `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`, {
    id: conversationId,
    title: 'Local smoke Save',
    playerProfile: { name: 'Smoke Traveler', description: 'Local smoke player' },
    setup: { origin: '梵尼亚' },
    maxResponseTokens: 64,
  });
  const conversation = conversationResponse.json();
  const generation = await inject('POST', `/api/conversations/${conversationId}/generations`, {
    conversationRevision: conversation.revision,
    mode: 'normal',
    userText: 'Run local smoke',
  });
  assert(generation.payload.includes(narrative) && generation.payload.includes('event: completed'), 'generation did not stream to completion');

  const messageResponse = await inject('GET', `/api/conversations/${conversationId}/messages`);
  const lastMessage = messageResponse.json().messages.at(-1);
  const activeVariant = lastMessage?.variants.find(({ id }) => id === lastMessage.activeVariantId);
  const optionBlocks = activeVariant?.document.blocks.filter(({ type }) => type === 'action-options') ?? [];
  assert(lastMessage?.role === 'assistant' && activeVariant?.status === 'completed'
    && activeVariant.content === narrative, 'generation did not persist the completed narrative');
  const expectedOptions = actionOptions.map((option, index) => ({ id: `option-${index + 1}`, ...option }));
  assert(optionBlocks.length === 1 && JSON.stringify(optionBlocks[0].options) === JSON.stringify(expectedOptions),
    'generation did not persist the expected seven Action Options');

  await Promise.all([
    inject('GET', '/api/providers'),
    inject('GET', '/api/scenes'),
  ]);
  const exposed = apiResponses.join('\n');
  const logged = logs.join('');
  const database = await readFile(databasePath);
  assert(!exposed.includes(apiKey), 'API response exposed the configured API key');
  assert(!logged.includes(apiKey), 'captured server logs exposed the configured API key');
  assert(!database.includes(Buffer.from(apiKey)), 'SQLite database contains the configured API key');
  assert(providerRequests.length === 2, `expected narrative and Action Options requests, received ${providerRequests.length}`);
  assert(providerRequests[0].purpose === 'narrative' && providerRequests[1].purpose === 'action-options',
    'provider requests did not follow the narrative then Action Options workflow');
  for (const request of providerRequests) {
    assert(request.method === 'POST' && request.path === '/v1/chat/completions', `unexpected provider path ${request.path}`);
    assert(request.body.model === 'mock-model', 'provider request used an unconfigured model');
    assert(request.authorization === `Bearer ${apiKey}`, 'provider request did not use the configured key');
  }
  const plannerUserMessage = providerRequests[1].body.messages.find(({ role }) => role === 'user');
  const plannerText = typeof plannerUserMessage?.content === 'string'
    ? plannerUserMessage.content
    : (plannerUserMessage?.content ?? []).filter(({ type }) => type === 'text').map(({ text }) => text).join('');
  const plannerInput = JSON.parse(plannerText);
  assert(plannerInput.playerInput === 'Run local smoke' && plannerInput.completedNarrative === narrative,
    'Action Options request did not use the completed narrative and player input');
  assert(outboundUrls.length === providerRequests.length && outboundUrls.every((url) => url === expectedUrl),
    `unexpected outbound calls: ${outboundUrls.join(', ')}`);

  console.log(`Local smoke: bound ${address.address}:${address.port}`);
  console.log(`Local smoke: Scene Save generated through ${providerRequests.length} configured-provider requests (narrative + seven Action Options), 0 telemetry requests`);
  console.log('Local smoke: API key absent from API responses, SQLite, and captured logs');
} finally {
  globalThis.fetch = originalFetch;
  if (app !== undefined) await app.close();
  await closeHttpServer(provider);
  await rm(dataDir, { recursive: true, force: true });
}
