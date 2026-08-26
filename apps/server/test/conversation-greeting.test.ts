import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const ids = {
  character: '018f2000-0000-7000-8000-000000000101',
  persona: '018f2000-0000-7000-8000-000000000102',
  provider: '018f2000-0000-7000-8000-000000000103',
  preset: '018f2000-0000-7000-8000-000000000104',
  conversation: '018f2000-0000-7000-8000-000000000105',
  rawConversation: '018f2000-0000-7000-8000-000000000106',
  message: '018f2000-0000-7000-8000-000000000107',
  duplicateVariant: '018f2000-0000-7000-8000-000000000108',
  systemMessage: '018f2000-0000-7000-8000-000000000109',
  narratorMessage: '018f2000-0000-7000-8000-000000000110',
};

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function testDatabase(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `tavernnext-${label}-`));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  return { directory, database };
}

describe('new conversation Character greetings', () => {
  it('atomically seeds firstMessage and ordered alternates once for route creation and active selection', async () => {
    const { directory, database } = await testDatabase('greeting-route');
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    repositories.characters.create({
      id: ids.character,
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: 'Main greeting',
      alternateGreetings: ['Alternate one', 'Alternate two'], tags: [],
    });
    repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
    repositories.providerProfiles.create({
      id: ids.provider, name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', model: 'mock', apiMode: 'chat',
    });
    repositories.presets.create({
      id: ids.preset, name: 'Greeting prompt', kind: 'chat', settings: {
        tokenizer: 0,
        prompts: [{ identifier: 'chatHistory', marker: true, system_prompt: true }],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'chatHistory', enabled: true }] }],
      },
    });
    expect(repositories.globalGenerationConfig.update(0, {
      providerId: ids.provider,
      chatPresetId: ids.preset,
    })).toMatchObject({ ok: true });
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
    });
    apps.push(app);
    await app.ready();
    const payload = {
      id: ids.conversation, characterId: ids.character, personaId: ids.persona,
      title: 'Seeded chat',
    };

    expect((await app.inject({ method: 'POST', url: '/api/conversations', payload })).statusCode).toBe(201);
    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/messages` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toEqual([expect.objectContaining({
      role: 'assistant',
      content: 'Main greeting',
      activeVariantId: expect.any(String),
      variants: [
        expect.objectContaining({ ordinal: 0, content: 'Main greeting', status: 'completed' }),
        expect.objectContaining({ ordinal: 1, content: 'Alternate one', status: 'completed' }),
        expect.objectContaining({ ordinal: 2, content: 'Alternate two', status: 'completed' }),
      ],
    })]);
    expect(detail.json().messages[0].activeVariantId).toBe(detail.json().messages[0].variants[0].id);

    const alternateVariantId = detail.json().messages[0].variants[1].id as string;
    const switched = await app.inject({
      method: 'PUT', url: `/api/messages/${detail.json().messages[0].id}/active-variant`,
      payload: { revision: detail.json().messages[0].revision, variantId: alternateVariantId },
    });
    expect(switched.statusCode).toBe(200);

    const selected = await app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/messages` });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().messages[0]).toMatchObject({
      activeVariantId: alternateVariantId,
      variants: expect.arrayContaining([expect.objectContaining({ id: alternateVariantId, content: 'Alternate one' })]),
    });

    expect((await app.inject({ method: 'POST', url: '/api/conversations', payload })).statusCode).toBe(400);
    const afterRetry = (await app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/messages` })).json();
    expect(afterRetry.messages).toHaveLength(1);
    expect(afterRetry.messages[0].variants).toHaveLength(3);
  });

  it('rolls back a failed greeting seed while raw import creation remains unseeded', async () => {
    const { database } = await testDatabase('greeting-atomic');
    const generatedIds = [ids.message, ids.duplicateVariant, ids.duplicateVariant];
    const repositories = createRepositories(database, {
      ...TEST_REPOSITORY_OPTIONS,
      createId: () => generatedIds.shift() ?? ids.duplicateVariant,
    });
    repositories.characters.create({
      id: ids.character,
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: 'Main greeting',
      alternateGreetings: ['Collision greeting'], tags: [],
    });
    repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
    const input = {
      id: ids.conversation, characterId: ids.character, personaId: ids.persona, title: 'Must roll back',
    };

    expect(() => repositories.conversations.createWithGreeting(input)).toThrow();
    expect(repositories.conversations.get(ids.conversation)).toBeUndefined();
    expect(repositories.messages.listByConversationId(ids.conversation)).toEqual([]);

    repositories.conversations.create({ ...input, id: ids.rawConversation, title: 'Imported chat' });
    expect(repositories.messages.listByConversationId(ids.rawConversation)).toEqual([]);
  });

  it('projects imported system and narrator speaker labels without exposing compatibility payloads', async () => {
    const { directory, database } = await testDatabase('speaker-labels');
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    repositories.characters.create({
      id: ids.character, name: 'Aster', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
    repositories.conversations.create({
      id: ids.conversation, characterId: ids.character, personaId: ids.persona, title: 'Imported chat',
    });
    repositories.messages.create({
      id: ids.systemMessage, conversationId: ids.conversation, role: 'system', content: 'System note', activeVariantId: null,
      compatibility: {
        sourceFormat: 'st-chat-jsonl', rawPayload: { isSystem: true, name: 'System' }, unknownFields: {},
        compatWarnings: [], parserVersion: '1',
      },
    });
    repositories.messages.create({
      id: ids.narratorMessage, conversationId: ids.conversation, role: 'system', content: 'Scene note', activeVariantId: null,
      compatibility: {
        sourceFormat: 'st-chat-jsonl', rawPayload: { isSystem: false, name: 'Narrator' }, unknownFields: {},
        compatWarnings: [], parserVersion: '1',
      },
    });
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
    });
    apps.push(app);
    await app.ready();

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/messages` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toEqual([
      expect.objectContaining({ role: 'system', content: 'System note', speakerLabel: 'System' }),
      expect.objectContaining({ role: 'system', content: 'Scene note', speakerLabel: 'Narrator' }),
    ]);
    expect(detail.payload).not.toContain('rawPayload');
  });
});
