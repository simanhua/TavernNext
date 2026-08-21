import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest, OpenAICompatibleClient } from '@tavernnext/provider-openai-compatible';
import { ProviderError } from '@tavernnext/provider-openai-compatible';
import { TokenizerId } from '@tavernnext/tokenizer-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { createGenerationService } from '../src/services/generation-service.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const ids = {
  character: '018f0000-0000-7000-8000-000000000101',
  persona: '018f0000-0000-7000-8000-000000000102',
  provider: '018f0000-0000-7000-8000-000000000103',
  conversation: '018f0000-0000-7000-8000-000000000104',
  preset: '018f0000-0000-7000-8000-000000000105',
};

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const databasesByRepository = new WeakMap<Repositories, ReturnType<typeof createDatabase>>();

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function mockClient(streamChat: OpenAICompatibleClient['streamChat']): OpenAICompatibleClient {
  return {
    listModels: async () => [],
    streamChat,
    streamText: async function* () { yield { type: 'completed', finishReason: 'stop' }; },
  };
}

type TestAppOptions = NonNullable<Parameters<typeof createApp>[0]> & {
  providerSecrets?: Readonly<Record<string, { providerId: string; baseUrl: string; value: string }>>;
};

async function createTestContext(client?: OpenAICompatibleClient, appOptions: TestAppOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  databasesByRepository.set(repositories, database);
  const app = createApp({
    ...appOptions,
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    ...(client === undefined ? {} : { providerClientFactory: () => client }),
  });
  apps.push(app);
  await app.ready();
  return { app, database, repositories };
}

function seed(repositories: Repositories) {
  const create = () => {
  const character = repositories.characters.create({
    id: ids.character,
    name: 'Aster',
    description: 'A careful archivist.',
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    tags: [],
  });
  const persona = repositories.personas.create({
    id: ids.persona,
    name: 'Traveler',
    description: 'A curious visitor.',
    isDefault: true,
  });
  const provider = repositories.providerProfiles.create({
    id: ids.provider,
    name: 'Local mock',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'mock-model',
    secretRef: 'mock-secret',
  });
  const preset = repositories.presets.create({
    id: ids.preset,
    name: 'Role chat',
    kind: 'chat',
    settings: {
      tokenizer: TokenizerId.NONE,
      prompts: [
        { identifier: 'main', role: 'system', content: 'Role chat', system_prompt: true },
        { identifier: 'charDescription', marker: true, role: 'system', system_prompt: true },
        { identifier: 'personaDescription', marker: true, role: 'system', system_prompt: true },
        { identifier: 'chatHistory', marker: true, system_prompt: true },
      ],
      prompt_order: [{
        character_id: character.id,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'personaDescription', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      }],
    },
  });
  const conversation = repositories.conversations.create({
    id: ids.conversation,
    characterId: character.id,
    personaId: persona.id,
    providerId: provider.id,
    presetId: preset.id,
    title: 'Archive visit',
  });
    return { character, persona, provider, preset, conversation };
  };
  const database = databasesByRepository.get(repositories);
  return database === undefined ? create() : database.transaction(create);
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(payload: string): SseEvent[] {
  return payload.trim().split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    if (event === undefined || data === undefined) throw new Error(`Malformed SSE frame: ${frame}`);
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}

async function generate(app: ReturnType<typeof createApp>, revision = 0) {
  return app.inject({
    method: 'POST',
    url: `/api/conversations/${ids.conversation}/generations`,
    payload: { conversationRevision: revision, mode: 'normal', userText: 'Hello' },
  });
}

describe('resource CRUD API', () => {
  it('creates, lists, reads, revises, and deletes characters, personas, providers, and conversations', async () => {
    const client = mockClient(async function* () { yield { type: 'completed', finishReason: 'stop' }; });
    const { app } = await createTestContext(client);
    const resources = [
      {
        path: 'characters',
        create: { id: ids.character, name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [] },
      },
      {
        path: 'personas',
        create: { id: ids.persona, name: 'Traveler', description: '', isDefault: true },
      },
      {
        path: 'providers',
        create: { id: ids.provider, name: 'Local', baseUrl: 'http://127.0.0.1:8080', model: 'mock', secretRef: 'server-only' },
      },
    ];

    for (const resource of resources) {
      const created = await app.inject({ method: 'POST', url: `/api/${resource.path}`, payload: resource.create });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ id: resource.create.id, revision: 0 });
      expect((await app.inject({ method: 'GET', url: `/api/${resource.path}` })).json()).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: `/api/${resource.path}/${resource.create.id}` })).json()).toMatchObject({ id: resource.create.id });

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/${resource.path}/${resource.create.id}`,
        payload: { revision: 0, patch: { name: `${resource.create.name} revised` } },
      });
      expect(updated.json()).toMatchObject({ revision: 1, name: `${resource.create.name} revised` });
    }

    const conversation = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { id: ids.conversation, characterId: ids.character, personaId: ids.persona, title: 'Chat' },
    });
    expect(conversation.statusCode).toBe(201);
    expect(conversation.json()).toMatchObject({ id: ids.conversation, revision: 0, worldbookIds: [] });

    expect((await app.inject({ method: 'DELETE', url: `/api/conversations/${ids.conversation}?revision=0` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/providers/${ids.provider}?revision=1` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/personas/${ids.persona}?revision=1` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/characters/${ids.character}?revision=1` })).statusCode).toBe(204);
  });
});

describe('generation API', () => {
  it('streams a complete role-chat turn and persists its transactional snapshot and messages', async () => {
    const requests: ChatRequest[] = [];
    const client = mockClient(async function* (request) {
      requests.push(request);
      yield { type: 'delta', text: 'Hello ' };
      yield { type: 'delta', text: 'there' };
      yield { type: 'usage', inputTokens: 12, outputTokens: 2 };
      yield { type: 'completed', finishReason: 'stop' };
    });
    const { app, repositories } = await createTestContext(client);
    const entities = seed(repositories);

    const response = await generate(app);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(response.payload);
    expect(events.map(({ event }) => event)).toEqual(['started', 'delta', 'delta', 'usage', 'completed']);
    expect(events.filter(({ event }) => event === 'delta').map(({ data }) => data.text).join('')).toBe('Hello there');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'mock-model' });
    expect(requests[0]?.messages[0]?.role).toBe('system');
    const systemContext = requests[0]?.messages.filter(({ role }) => role === 'system')
      .map(({ content }) => content).join('\n') ?? '';
    expect(systemContext).toContain(entities.character.description);
    expect(systemContext).toContain(entities.persona.description);
    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello' });

    const messages = repositories.messages.list().filter(({ conversationId }) => conversationId === ids.conversation);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello', activeVariantId: null });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '', activeVariantId: expect.any(String) });
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({ messageId: messages[1]?.id, content: 'Hello there', status: 'completed', finishReason: 'stop' }),
    ]);
    expect(repositories.conversations.get(ids.conversation)).toMatchObject({ revision: 1 });
    expect(repositories.generationSnapshots.list()).toEqual([
      expect.objectContaining({
        id: events[0]?.data.generationId,
        conversationId: ids.conversation,
        conversationRevision: 0,
        payload: expect.objectContaining({
          schemaVersion: 4,
          input: expect.objectContaining({ conversationId: ids.conversation, conversationRevision: 0 }),
          compiledRequest: requests[0],
        }),
      }),
    ]);
  });

  it('rejects a second active generation and stale revisions before any write', async () => {
    const entered = deferred();
    const release = deferred();
    const client = mockClient(async function* () {
      entered.resolve();
      await release.promise;
      yield { type: 'completed', finishReason: 'stop' };
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const first = generate(app);
    await entered.promise;
    const simultaneous = await generate(app);
    expect(simultaneous.statusCode).toBe(409);
    expect(simultaneous.json()).toEqual({ error: 'generation_active' });
    expect(repositories.messages.list()).toHaveLength(1);

    release.resolve();
    await first;
    const beforeStale = {
      messages: repositories.messages.list().length,
      snapshots: repositories.generationSnapshots.list().length,
    };
    const stale = await generate(app, 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'revision_conflict' });
    expect(repositories.messages.list()).toHaveLength(beforeStale.messages);
    expect(repositories.generationSnapshots.list()).toHaveLength(beforeStale.snapshots);
  });

  it('rejects invalid targets or requests and cleans up reservations before iteration', async () => {
    let providerCalls = 0;
    const client = mockClient(async function* () {
      providerCalls += 1;
      yield { type: 'completed', finishReason: 'stop' };
    });
    const { app, database, repositories } = await createTestContext(client);
    seed(repositories);

    const invalidTarget = await app.inject({
      method: 'POST',
      url: `/api/conversations/${ids.conversation}/generations`,
      payload: { conversationRevision: 0, mode: 'regenerate' },
    });
    expect(invalidTarget.statusCode).toBe(400);
    expect(invalidTarget.json()).toEqual({ error: 'invalid_target' });

    for (const userText of [undefined, '', '   ', '\t\n']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/conversations/${ids.conversation}/generations`,
        payload: {
          conversationRevision: 0,
          mode: 'normal',
          ...(userText === undefined ? {} : { userText }),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_user_text' });
    }

    expect(providerCalls).toBe(0);
    expect(repositories.messages.list()).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.conversations.get(ids.conversation)).toMatchObject({ revision: 0 });
    const service = createGenerationService({ database, repositories, providerClientFactory: () => client });

    await expect(service.start({ conversationId: ids.conversation, conversationRevision: 0, mode: 'normal' }))
      .resolves.toEqual({ ok: false, reason: 'invalid_user_text' });
    expect(providerCalls).toBe(0);
    expect(repositories.messages.list()).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.conversations.get(ids.conversation)).toMatchObject({ revision: 0 });

    const accepted = await service.start({
      conversationId: ids.conversation, conversationRevision: 0, mode: 'normal', userText: 'Accepted',
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      for await (const event of accepted.events) void event;
    }

    expect(providerCalls).toBe(1);
    expect(repositories.messages.list()).toEqual([
      expect.objectContaining({ role: 'user', content: 'Accepted' }),
    ]);
    expect(repositories.generationSnapshots.list()).toHaveLength(1);
    expect(repositories.conversations.get(ids.conversation)).toMatchObject({ revision: 1 });

    const first = await service.start({
      conversationId: ids.conversation, conversationRevision: 1, mode: 'normal', userText: 'Cancelled before iteration',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);

    expect(service.cancel(first.generationId)).toBe(true);
    await expect(first.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    const second = await service.start({
      conversationId: ids.conversation, conversationRevision: 2, mode: 'normal', userText: 'After cancellation',
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      for await (const event of second.events) void event;
    }

    const abandoned = await service.start({
      conversationId: ids.conversation, conversationRevision: 3, mode: 'normal', userText: 'Closed before iteration',
    });
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) throw new Error(abandoned.reason);
    const iterator = abandoned.events[Symbol.asyncIterator]();

    await iterator.return?.();
    const afterClose = await service.start({
      conversationId: ids.conversation, conversationRevision: 4, mode: 'normal', userText: 'After close',
    });
    expect(afterClose.ok).toBe(true);
    if (afterClose.ok) {
      for await (const event of afterClose.events) void event;
    }

    expect(providerCalls).toBe(3);
  });

  it('releases the conversation lock when the SSE consumer disconnects after started', async () => {
    const client = mockClient(async function* () { yield { type: 'completed', finishReason: 'stop' }; });
    const { database, repositories } = await createTestContext(client);
    seed(repositories);
    const service = createGenerationService({ database, repositories, providerClientFactory: () => client });
    const first = await service.start({
      conversationId: ids.conversation, conversationRevision: 0, mode: 'normal', userText: 'Hello',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    const iterator = first.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'started' } });
    await iterator.return?.();

    const second = await service.start({
      conversationId: ids.conversation, conversationRevision: 1, mode: 'normal', userText: 'Again',
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      for await (const event of second.events) void event;
    }
  });

  it('aborts upstream and partial persistence when the SSE consumer disconnects mid-stream', async () => {
    let providerSignal: AbortSignal | undefined;
    const client = mockClient(async function* (_request, signal) {
      providerSignal = signal;
      yield { type: 'delta', text: 'Disconnected partial' };
      await new Promise(() => undefined);
    });
    const { database, repositories } = await createTestContext(client);
    seed(repositories);
    const service = createGenerationService({ database, repositories, providerClientFactory: () => client });
    const result = await service.start({
      conversationId: ids.conversation, conversationRevision: 0, mode: 'normal', userText: 'Hello',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'delta', text: 'Disconnected partial' } });
    await iterator.return?.();

    expect(providerSignal?.aborted).toBe(true);
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({ content: 'Disconnected partial', status: 'aborted' }),
    ]);
  });

  it('keeps streamed text in memory until the terminal persistence boundary', async () => {
    const waiting = deferred();
    const release = deferred();
    const client = mockClient(async function* () {
      yield { type: 'delta', text: 'A' };
      yield { type: 'delta', text: ' timed flush' };
      waiting.resolve();
      await release.promise;
      yield { type: 'completed', finishReason: 'stop' };
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const response = generate(app);
    await waiting.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(repositories.messageVariants.list()).toEqual([]);
    release.resolve();
    await response;
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({ content: 'A timed flush', status: 'completed', revision: 1 }),
    ]);
  });

  it('does not rewrite SQLite when a large content delta arrives mid-stream', async () => {
    const waiting = deferred();
    const release = deferred();
    const client = mockClient(async function* () {
      yield { type: 'delta', text: 'A' };
      yield { type: 'delta', text: 'b'.repeat(256) };
      waiting.resolve();
      await release.promise;
      yield { type: 'completed', finishReason: 'stop' };
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const response = generate(app);
    await waiting.promise;
    expect(repositories.messageVariants.list()).toEqual([]);
    release.resolve();
    await response;
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({ content: `A${'b'.repeat(256)}`, status: 'completed', revision: 1 }),
    ]);
  });

  it('retains partial content and marks it aborted when cancellation is requested', async () => {
    const waiting = deferred();
    const client = mockClient(async function* (_request, signal) {
      yield { type: 'delta', text: 'Partial answer' };
      waiting.resolve();
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new ProviderError('aborted')), { once: true });
      });
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const response = generate(app);
    await waiting.promise;
    const generationId = repositories.generationSnapshots.list()[0]?.id;
    const cancellation = await app.inject({ method: 'DELETE', url: `/api/generations/${generationId}` });
    expect(cancellation.statusCode).toBe(202);

    const events = parseSse((await response).payload);
    expect(events.map(({ event }) => event)).toEqual(['started', 'delta', 'aborted']);
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({ content: 'Partial answer', status: 'aborted' }),
    ]);
  });

  it('emits failed without creating an empty assistant message when upstream fails before a delta', async () => {
    const client = mockClient(async function* () {
      throw new ProviderError('connection');
      yield undefined as never;
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const response = await generate(app);

    expect(response.statusCode).toBe(200);
    expect(parseSse(response.payload).map(({ event }) => event)).toEqual(['started', 'failed']);
    expect(repositories.messages.list()).toEqual([
      expect.objectContaining({ role: 'user', content: 'Hello' }),
    ]);
    expect(repositories.messageVariants.list()).toEqual([]);
  });

  it('streams and persists reasoning separately from the final answer', async () => {
    const client = mockClient(async function* () {
      for (let index = 0; index < 200; index += 1) {
        yield { type: 'reasoning_delta', text: `Private working note ${index}.` };
      }
      yield { type: 'delta', text: 'Final answer.' };
      yield { type: 'completed', finishReason: 'stop' };
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const response = await generate(app);

    const events = parseSse(response.payload);
    expect(events[0]?.event).toBe('started');
    expect(events.filter(({ event }) => event === 'reasoning_delta')).toHaveLength(200);
    expect(events.slice(-2).map(({ event }) => event)).toEqual(['delta', 'completed']);
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({
        reasoning: expect.stringContaining('Private working note 199.'),
        content: 'Final answer.', status: 'completed', revision: 1,
      }),
    ]);
  });

  it('promotes visible reasoning when a provider completes without a separate final-content channel', async () => {
    const client = mockClient(async function* () {
      yield { type: 'reasoning_delta', text: 'The response budget was consumed by reasoning.' };
      yield { type: 'completed', finishReason: 'length' };
    });
    const { app, repositories } = await createTestContext(client);
    seed(repositories);

    const response = await generate(app);
    const events = parseSse(response.payload);

    expect(events.map(({ event }) => event)).toEqual(['started', 'reasoning_delta', 'completed']);
    expect(repositories.messageVariants.list()).toEqual([
      expect.objectContaining({
        content: 'The response budget was consumed by reasoning.', status: 'completed',
      }),
    ]);
  });

  it('does not resolve a client-selected secret reference from the process environment', async () => {
    let sentAuthorization = false;
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      sentAuthorization = new Headers(init?.headers).has('authorization');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { app, repositories } = await createTestContext();
    seed(repositories);
    expect(repositories.providerProfiles.update(ids.provider, 0, { secretRef: 'PATH' })).toMatchObject({ ok: true });

    const response = await generate(app);

    expect(response.statusCode).toBe(200);
    expect(sentAuthorization).toBe(false);
  });

  it('uses only server-owned credentials bound to the provider profile and Base URL', async () => {
    const authorization: boolean[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).has('authorization'));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { app, repositories } = await createTestContext(undefined, {
      providerSecrets: {
        'mock-secret': {
          providerId: ids.provider,
          baseUrl: 'http://127.0.0.1:8080/v1',
          value: 'server-owned-api-key',
        },
      },
    });
    seed(repositories);

    expect((await generate(app)).statusCode).toBe(200);
    expect(repositories.providerProfiles.update(ids.provider, 0, { baseUrl: 'http://attacker.invalid/v1' })).toMatchObject({ ok: true });
    expect((await generate(app, 1)).statusCode).toBe(200);

    expect(authorization).toEqual([true, false]);
  });
});
