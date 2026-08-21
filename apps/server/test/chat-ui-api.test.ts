import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenizerId } from '@tavernnext/tokenizer-engine';
import { ProviderError, type OpenAICompatibleProfile } from '@tavernnext/provider-openai-compatible';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const ids = {
  character: '018f0000-0000-7000-8000-000000000101',
  persona: '018f0000-0000-7000-8000-000000000102',
  provider: '018f0000-0000-7000-8000-000000000103',
  conversation: '018f0000-0000-7000-8000-000000000104',
  userMessage: '018f0000-0000-7000-8000-000000000105',
  assistantMessage: '018f0000-0000-7000-8000-000000000106',
  variant: '018f0000-0000-7000-8000-000000000107',
  preset: '018f0000-0000-7000-8000-000000000108',
};

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

describe('chat UI API bindings', () => {
  it('serves editable message views and never returns browser-provided API keys', async () => {
    const authorization: Array<string | null> = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-chat-ui-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'test.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
    });
    apps.push(app);
    await app.ready();

    const apiKey = 'task-5-recognizable-api-key';
    const created = await app.inject({
      method: 'POST', url: '/api/providers',
      payload: {
        id: ids.provider, name: 'Browser configured', baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'mock', apiMode: 'chat', apiKey,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: ids.provider, hasApiKey: true });
    expect(created.payload).not.toContain(apiKey);
    expect(created.json()).not.toHaveProperty('apiKey');
    expect(created.json()).not.toHaveProperty('secretRef');
    const listed = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(listed.json()).toEqual([expect.objectContaining({ id: ids.provider, hasApiKey: true })]);
    expect(listed.payload).not.toContain(apiKey);
    expect(listed.json()[0]).not.toHaveProperty('secretRef');

    repositories.characters.create({
      id: ids.character, name: 'Aster', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
    repositories.presets.create({
      id: ids.preset,
      name: 'Role chat',
      kind: 'chat',
      settings: {
        tokenizer: TokenizerId.NONE,
        secret_selector_sentinel: 'MUST-NOT-LEAVE-SERVER',
        prompts: [
          { identifier: 'main', role: 'system', content: 'Role chat', system_prompt: true },
          { identifier: 'chatHistory', marker: true, system_prompt: true },
        ],
        prompt_order: [{
          character_id: ids.character,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'chatHistory', enabled: true },
          ],
        }],
      },
      compatibility: {
        sourceFormat: 'test',
        rawPayload: { secret_raw_sentinel: 'MUST-NOT-LEAVE-SERVER' },
        unknownFields: { secret_unknown_sentinel: 'MUST-NOT-LEAVE-SERVER' },
        compatWarnings: ['secret_warning_sentinel'],
        parserVersion: '1',
      },
    });
    const listedPresets = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(listedPresets.statusCode).toBe(200);
    expect(listedPresets.json()).toEqual([{
      id: ids.preset, revision: 0, kind: 'chat', name: 'Role chat',
    }]);
    expect(listedPresets.payload).not.toContain('MUST-NOT-LEAVE-SERVER');
    expect(listedPresets.payload).not.toContain('secret_warning_sentinel');
    expect(repositories.globalGenerationConfig.update(0, {
      providerId: ids.provider,
      chatPresetId: ids.preset,
    })).toMatchObject({ ok: true });
    repositories.conversations.create({
      id: ids.conversation,
      characterId: ids.character,
      personaId: ids.persona,
      title: 'Chat',
    });
    const userMessage = repositories.messages.create({
      id: ids.userMessage, conversationId: ids.conversation, role: 'user', content: 'Original', activeVariantId: null,
    });
    const assistantMessage = repositories.messages.create({
      id: ids.assistantMessage, conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: ids.variant, messageId: assistantMessage.id, content: 'Reply', status: 'completed', finishReason: 'stop',
    });
    expect(repositories.messages.update(assistantMessage.id, 0, { activeVariantId: variant.id }).ok).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/messages` });
    expect(detail.json()).toMatchObject({
      conversation: { id: ids.conversation },
      messages: [
        { id: userMessage.id, variants: [] },
        { id: assistantMessage.id, variants: [{ id: variant.id, content: 'Reply' }] },
      ],
    });
    const updated = await app.inject({
      method: 'PATCH', url: `/api/messages/${userMessage.id}`,
      payload: { revision: 0, patch: { content: 'Edited' } },
    });
    expect(updated.json()).toMatchObject({ content: 'Edited', revision: 1 });
    expect((await app.inject({
      method: 'DELETE', url: `/api/messages/${assistantMessage.id}?revision=1`,
    })).statusCode).toBe(204);
    expect(repositories.messageVariants.get(variant.id)).toBeUndefined();

    const rotatedApiKey = 'task-5-rotated-api-key';
    const updatedProvider = await app.inject({
      method: 'PATCH', url: `/api/providers/${ids.provider}`,
      payload: { revision: 0, patch: { model: 'mock-updated', apiKey: rotatedApiKey } },
    });
    expect(updatedProvider.json()).toMatchObject({ revision: 1, model: 'mock-updated', hasApiKey: true });
    expect(updatedProvider.payload).not.toContain(rotatedApiKey);
    expect(updatedProvider.json()).not.toHaveProperty('secretRef');
    const metadataOnlyUpdate = await app.inject({
      method: 'PATCH', url: `/api/providers/${ids.provider}`,
      payload: { revision: 1, patch: { name: 'Browser configured again' } },
    });
    expect(metadataOnlyUpdate.json()).toMatchObject({ revision: 2, hasApiKey: true });

    const generation = await app.inject({
      method: 'POST', url: `/api/conversations/${ids.conversation}/generations`,
      payload: { conversationRevision: 0, mode: 'normal', userText: 'Hello' },
    });
    expect(generation.statusCode).toBe(200);
    expect(authorization).toEqual([`Bearer ${rotatedApiKey}`]);

    const changedBaseUrl = await app.inject({
      method: 'PATCH', url: `/api/providers/${ids.provider}`,
      payload: { revision: 2, patch: { baseUrl: 'http://attacker.invalid/v1' } },
    });
    expect(changedBaseUrl.json()).toMatchObject({ revision: 3, hasApiKey: false });
    const generationAfterBaseUrlChange = await app.inject({
      method: 'POST', url: `/api/conversations/${ids.conversation}/generations`,
      payload: { conversationRevision: 1, mode: 'normal', userText: 'Again' },
    });
    expect(generationAfterBaseUrlChange.statusCode).toBe(200);
    expect(authorization).toEqual([`Bearer ${rotatedApiKey}`, null]);
  });

  it('probes draft and saved provider credentials while returning only safe model metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-provider-probe-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'test.sqlite'));
    migrateDatabase(database);
    const observedProfiles: OpenAICompatibleProfile[] = [];
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      providerProbeFactory: (profile) => ({
        async listModels() {
          observedProfiles.push(profile);
          if (profile.baseUrl.includes('offline')) throw new ProviderError('connection');
          return [{ id: 'model-alpha', ownedBy: 'test' }, { id: 'model-beta' }];
        },
      }),
    });
    apps.push(app);
    await app.ready();

    const savedApiKey = 'saved-probe-key';
    expect((await app.inject({
      method: 'POST', url: '/api/providers',
      payload: {
        id: ids.provider, name: 'Saved provider', baseUrl: 'https://saved.example/v1',
        model: 'model-alpha', apiMode: 'chat', apiKey: savedApiKey,
      },
    })).statusCode).toBe(201);

    const connection = await app.inject({
      method: 'POST', url: '/api/providers/probe',
      payload: { id: ids.provider, baseUrl: 'https://saved.example/v1' },
    });
    expect(connection.statusCode).toBe(200);
    expect(connection.json()).toEqual({ ok: true, modelCount: 2 });
    expect(connection.payload).not.toContain(savedApiKey);
    expect(observedProfiles[0]).toEqual({ baseUrl: 'https://saved.example/v1', apiKey: savedApiKey });

    const draftApiKey = 'draft-probe-key';
    const models = await app.inject({
      method: 'POST', url: '/api/providers/models',
      payload: { baseUrl: 'https://draft.example', apiKey: draftApiKey },
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ models: [{ id: 'model-alpha', ownedBy: 'test' }, { id: 'model-beta' }] });
    expect(models.payload).not.toContain(draftApiKey);
    expect(observedProfiles[1]).toEqual({ baseUrl: 'https://draft.example', apiKey: draftApiKey });

    const invalid = await app.inject({ method: 'POST', url: '/api/providers/probe', payload: { baseUrl: 'file:///secret' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'invalid_request' });

    const offline = await app.inject({ method: 'POST', url: '/api/providers/models', payload: { baseUrl: 'https://offline.example' } });
    expect(offline.statusCode).toBe(502);
    expect(offline.json()).toEqual({ error: 'provider_connection_failed' });
  });
});
