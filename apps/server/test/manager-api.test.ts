import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { createTestSceneSave } from './scene-save-fixture.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const ids = {
  character: '018f0000-0000-7000-8000-000000000951',
  persona: '018f0000-0000-7000-8000-000000000952',
  personaTwo: '018f0000-0000-7000-8000-000000000953',
  preset: '018f0000-0000-7000-8000-000000000954',
  worldbook: '018f0000-0000-7000-8000-000000000955',
  entry: '018f0000-0000-7000-8000-000000000956',
  entryTwo: '018f0000-0000-7000-8000-000000000957',
  conversation: '018f0000-0000-7000-8000-000000000959',
};
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-manager-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  repositories.characters.create({
    id: ids.character, name: 'Aster', description: 'Archivist', personality: 'Patient', scenario: 'Library', firstMessage: 'Welcome',
    alternateGreetings: ['Hello'], tags: ['lore'], examples: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '',
    characterVersion: '', depthPrompt: '', worldbookId: ids.worldbook, extensions: {}, avatarPath: 'assets/imports/avatar-secret.png',
    compatibility: {
      sourceFormat: 'st-character-v3', rawPayload: { trustAnchor: 'RAW-CHARACTER-SENTINEL' },
      unknownFields: { api_key: 'CHARACTER-SECRET' }, compatWarnings: ['future_character'], parserVersion: '1',
    },
  });
  repositories.personas.create({
    id: ids.persona, name: 'Traveler', description: 'Curious', isDefault: true,
    compatibility: {
      sourceFormat: 'native-persona', rawPayload: { hidden: 'RAW-PERSONA-SENTINEL' },
      unknownFields: {}, compatWarnings: ['future_persona'], parserVersion: '1',
    },
  });
  repositories.personas.create({ id: ids.personaTwo, name: 'Scholar', description: 'Reader', isDefault: false });
  repositories.presets.create({
    id: ids.preset, name: 'Role Chat', kind: 'chat',
    settings: {
      temperature: 0.7,
      prompts: [{ identifier: 'main', role: 'system', content: 'Main', enabled: true, __tavernnextPresetSource: { token: 'INTERNAL-MARKER' } }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
      provider_api_key: 'PRESET-SECRET',
    },
    compatibility: {
      sourceFormat: 'preset:chat', rawPayload: { hidden: 'RAW-PRESET-SENTINEL' },
      unknownFields: { vendor: { token: 'PRESET-VENDOR-SECRET' } },
      compatWarnings: ['provider_field_preserved_not_executable'], parserVersion: '1',
    },
  });
  repositories.worldbooks.create({
    id: ids.worldbook, name: 'Archive Lore', description: 'Facts', enabled: true, scanDepth: 4, tokenBudget: 512,
    recursiveScanning: true, isGlobal: false, extensions: { future_runtime_hint: 'WORLDBOOK-EXTENSION-PRIVATE' },
    compatibility: {
      sourceFormat: 'worldbook:st-native', rawPayload: { hidden: 'RAW-WORLDBOOK-SENTINEL' },
      unknownFields: { vendor: 'WORLDBOOK-SECRET' }, compatWarnings: ['future_book'], parserVersion: '1',
    },
  });
  const entry = {
    worldbookId: ids.worldbook, keys: ['archive'], content: 'The archive remembers.', sourceUid: 42, sourceOrdinal: 0,
    comment: 'Reader core', enabled: false,
    compatibility: {
      sourceFormat: 'worldbook-entry:st-native', rawPayload: { hidden: 'RAW-ENTRY-SENTINEL' },
      unknownFields: { vendor: 'ENTRY-SECRET' }, compatWarnings: ['future_entry'], parserVersion: '1',
    },
  };
  repositories.worldbookEntries.create({ id: ids.entry, ...entry, order: 10 });
  repositories.worldbookEntries.create({ id: ids.entryTwo, ...entry, sourceUid: 'second', sourceOrdinal: 1, order: 20 });
  const conversation = createTestSceneSave(repositories, {
    id: ids.conversation, characterId: ids.character, personaId: ids.persona,
    title: 'Scene Save', worldbookIds: [],
  }, { presetId: ids.preset });
  const saveWorldbook = repositories.saveWorldbooks.getByConversationId(conversation.id)!;
  const saveEntries = repositories.worldbookEntries.listByWorldbookId(saveWorldbook.worldbookId);
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories, conversation, saveWorldbook, saveEntries };
}

describe('sanitized manager APIs', () => {
  it('returns the effective Save Preset and deduplicated Worldbooks in runtime precedence order', async () => {
    const { app, repositories, conversation, saveWorldbook, saveEntries } = await context();
    const worldbookId = saveWorldbook.worldbookId;
    const entryId = saveEntries[0]!.id;
    const globalWorldbookId = '018f0000-0000-7000-8000-000000000960';
    repositories.worldbooks.create({
      id: globalWorldbookId, name: 'Global Rules', description: '', enabled: true,
      scanDepth: null, tokenBudget: null, recursiveScanning: false, isGlobal: true, extensions: {},
    });
    expect(repositories.conversations.update(conversation.id, conversation.revision, {
      worldbookIds: [worldbookId, globalWorldbookId],
    }).ok).toBe(true);
    repositories.worldbookRuntimeStates.create({
      id: '018f0000-0000-7000-8000-000000000962',
      conversationId: ids.conversation,
      timedState: { messageIndex: null, sticky: [], cooldown: [] },
      entryOverrides: [{ source: 'character', comment: 'Reader core', enabled: true }],
    });

    const response = await app.inject({
      method: 'GET', url: `/api/conversations/${ids.conversation}/runtime-references`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configuration: { name: 'Role Chat', settings: { temperature: 0.7 } },
      worldbooks: [
        { source: 'global', value: { id: globalWorldbookId, name: 'Global Rules' } },
        { source: 'character', saveOwned: true, value: { id: worldbookId, name: 'Archive Lore' } },
      ],
    });
    expect(response.json().worldbooks).toHaveLength(2);
    expect(response.json().worldbooks[1].value.entries[0]).toMatchObject({
      comment: 'Reader core',
      enabled: false,
      effectiveEnabled: true,
      activationSource: 'save',
      saveOverrideEnabled: false,
    });

    const prompt = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${ids.conversation}/runtime-references/preset-prompts/main`,
      payload: { revision: 0, enabled: false },
    });
    expect(prompt.statusCode).toBe(200);
    const toggledPrompt = prompt.json();
    expect(toggledPrompt.revision).toBe(1);
    expect(toggledPrompt.settings.prompts.find((item: { identifier: string }) => item.identifier === 'main'))
      .toMatchObject({ enabled: false });
    expect(toggledPrompt.settings.prompt_order[0].order.find((item: { identifier: string }) => item.identifier === 'main'))
      .toMatchObject({ enabled: false });
    const required = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${ids.conversation}/runtime-references/preset-prompts/chatHistory`,
      payload: { revision: 1, enabled: false },
    });
    expect(required.statusCode).toBe(400);
    expect(required.json()).toEqual({ error: 'prompt_required' });

    const book = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${ids.conversation}/runtime-references/worldbooks/${worldbookId}`,
      payload: { revision: 0, enabled: false },
    });
    expect(book.statusCode).toBe(200);
    expect(book.json()).toMatchObject({ id: worldbookId, revision: 1, enabled: false });
    const entry = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${ids.conversation}/runtime-references/worldbooks/${worldbookId}/entries/${entryId}`,
      payload: { revision: 0, enabled: true },
    });
    expect(entry.statusCode).toBe(200);
    expect(entry.json()).toMatchObject({ id: entryId, revision: 1, enabled: true });
  });

  it('returns safe Persona, Chat Preset, and Save Worldbook DTOs without private compatibility data', async () => {
    const { app, saveWorldbook, saveEntries } = await context();
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/personas' }),
      app.inject({ method: 'GET', url: `/api/personas/${ids.persona}` }),
      app.inject({ method: 'GET', url: '/api/presets' }),
      app.inject({ method: 'GET', url: `/api/presets/${ids.preset}` }),
      app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/runtime-references` }),
    ]);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const serialized = responses.map((response) => response.body).join('\n');
    for (const forbidden of [
      'rawPayload', 'unknownFields', 'RAW-PERSONA-SENTINEL', 'RAW-PRESET-SENTINEL',
      'PRESET-SECRET', 'PRESET-VENDOR-SECRET', 'INTERNAL-MARKER', '__tavernnextPresetSource',
      'RAW-WORLDBOOK-SENTINEL', 'WORLDBOOK-SECRET', 'WORLDBOOK-EXTENSION-PRIVATE', 'RAW-ENTRY-SENTINEL', 'ENTRY-SECRET',
    ]) expect(serialized).not.toContain(forbidden);
    expect(responses[1]!.json()).toMatchObject({
      name: 'Traveler', compatibilitySummary: { sourceFormat: 'native-persona', warnings: ['future_persona'] },
    });
    expect(responses[3]!.json()).toMatchObject({ name: 'Role Chat', kind: 'chat', settings: { temperature: 0.7 } });
    const book = responses[4]!.json().worldbooks[0].value;
    expect(book).toMatchObject({
      id: saveWorldbook.worldbookId, name: 'Archive Lore', scanDepth: 4, tokenBudget: 512, recursiveScanning: true,
      entries: [
        { id: saveEntries[0]!.id, sourceUid: 42, sourceOrdinal: 0 },
        { id: saveEntries[1]!.id, sourceUid: 'second', sourceOrdinal: 1 },
      ],
    });
    expect(book).not.toHaveProperty('extensions');
  });

  it('accepts explicit revisioned patches, rejects private or mistyped fields, and preserves state on conflicts', async () => {
    const { app, repositories } = await context();
    const invalidPersona = await app.inject({
      method: 'PATCH', url: `/api/personas/${ids.persona}`,
      payload: { revision: 0, patch: { description: 'Allowed', compatibility: { rawPayload: 'forged' } } },
    });
    expect(invalidPersona.statusCode).toBe(400);
    expect(repositories.personas.get(ids.persona)?.description).toBe('Curious');
    const updated = await app.inject({
      method: 'PATCH', url: `/api/personas/${ids.persona}`,
      payload: { revision: 0, patch: { description: 'Edited' } },
    });
    expect(updated.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'PATCH', url: `/api/personas/${ids.persona}`,
      payload: { revision: 0, patch: { description: 'Stale overwrite' } },
    });
    expect(stale.statusCode).toBe(409);
    expect(repositories.personas.get(ids.persona)?.description).toBe('Edited');

    const invalidPreset = await app.inject({
      method: 'PATCH', url: `/api/presets/${ids.preset}`,
      payload: { revision: 0, patch: { settings: { temperature: 'hot' } } },
    });
    expect(invalidPreset.statusCode).toBe(400);
    expect(repositories.presets.get(ids.preset)?.settings.temperature).toBe(0.7);

    const clearedPreset = await app.inject({
      method: 'PATCH', url: `/api/presets/${ids.preset}`,
      payload: { revision: 0, patch: { deleteSettingKeys: ['temperature'] } },
    });
    expect(clearedPreset.statusCode).toBe(200);
    expect(repositories.presets.get(ids.preset)?.settings).not.toHaveProperty('temperature');

    const unsafeClear = await app.inject({
      method: 'PATCH', url: `/api/presets/${ids.preset}`,
      payload: { revision: 1, patch: { deleteSettingKeys: ['provider_api_key'] } },
    });
    expect(unsafeClear.statusCode).toBe(400);

    const emptySettings = await app.inject({
      method: 'PATCH', url: `/api/presets/${ids.preset}`,
      payload: { revision: 1, patch: { settings: {} } },
    });
    expect(emptySettings.statusCode).toBe(400);
    expect(repositories.presets.get(ids.preset)?.revision).toBe(1);

    const unchangedName = await app.inject({
      method: 'PATCH', url: `/api/presets/${ids.preset}`,
      payload: { revision: 1, patch: { name: 'Role Chat' } },
    });
    expect(unchangedName.statusCode).toBe(400);
    expect(repositories.presets.get(ids.preset)?.revision).toBe(1);

  });

  it('keeps Persona default transitions and Save Worldbook reorder operations atomic', async () => {
    const { app, repositories, saveWorldbook, saveEntries } = await context();
    const worldbookId = saveWorldbook.worldbookId;
    const entryId = saveEntries[0]!.id;
    const entryTwoId = saveEntries[1]!.id;
    const selected = await app.inject({
      method: 'PATCH', url: `/api/personas/${ids.personaTwo}`,
      payload: { revision: 0, patch: { isDefault: true } },
    });
    expect(selected.statusCode).toBe(200);
    expect(repositories.personas.list().filter((persona) => persona.isDefault).map((persona) => persona.id)).toEqual([ids.personaTwo]);

    const staleReorder = await app.inject({
      method: 'PUT', url: `/api/conversations/${ids.conversation}/save-worldbook/${worldbookId}/entries/order`,
      payload: { entries: [{ id: entryId, revision: 0, order: 20 }, { id: entryTwoId, revision: 99, order: 10 }] },
    });
    expect(staleReorder.statusCode).toBe(409);
    expect(repositories.worldbookEntries.listByWorldbookId(worldbookId).map((entry) => [entry.id, entry.order])).toEqual([
      [entryId, 10], [entryTwoId, 20],
    ]);

    const reordered = await app.inject({
      method: 'PUT', url: `/api/conversations/${ids.conversation}/save-worldbook/${worldbookId}/entries/order`,
      payload: { entries: [{ id: entryId, revision: 0, order: 20 }, { id: entryTwoId, revision: 0, order: 10 }] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(repositories.worldbookEntries.listByWorldbookId(worldbookId).map((entry) => [entry.id, entry.order])).toEqual([
      [entryId, 20], [entryTwoId, 10],
    ]);
  });

  it('rejects cross-scope and stale Save Worldbook entry edits and deletes only the owned entry', async () => {
    const { app, repositories, saveWorldbook, saveEntries } = await context();
    const worldbookId = saveWorldbook.worldbookId;
    const entry = saveEntries[0]!;
    const route = `/api/conversations/${ids.conversation}/save-worldbook/${worldbookId}/entries/${entry.id}`;
    const invalid = await app.inject({
      method: 'PATCH', url: route,
      payload: { revision: 0, patch: { content: 'Allowed', sourceUid: 'forged', sourceOrdinal: 99 } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(repositories.worldbookEntries.get(entry.id)?.content).toBe('The archive remembers.');
    const foreign = await app.inject({
      method: 'DELETE', url: `/api/conversations/${ids.conversation}/save-worldbook/${ids.worldbook}/entries/${ids.entry}?revision=0`,
    });
    expect(foreign.statusCode).toBe(404);
    expect(repositories.worldbookEntries.get(ids.entry)).toBeDefined();
    const stale = await app.inject({ method: 'DELETE', url: `${route}?revision=99` });
    expect(stale.statusCode).toBe(409);
    expect(repositories.worldbookEntries.get(entry.id)).toBeDefined();
    const deleted = await app.inject({ method: 'DELETE', url: `${route}?revision=0` });
    expect(deleted.statusCode).toBe(204);
    expect(repositories.worldbookEntries.get(entry.id)).toBeUndefined();
    expect(repositories.worldbookEntries.get(ids.entry)).toBeDefined();
    expect(repositories.worldbookEntries.listByWorldbookId(worldbookId)).toHaveLength(1);
  });
});
