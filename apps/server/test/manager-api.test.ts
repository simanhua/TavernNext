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
  character: '018f0000-0000-7000-8000-000000000951',
  persona: '018f0000-0000-7000-8000-000000000952',
  personaTwo: '018f0000-0000-7000-8000-000000000953',
  preset: '018f0000-0000-7000-8000-000000000954',
  worldbook: '018f0000-0000-7000-8000-000000000955',
  entry: '018f0000-0000-7000-8000-000000000956',
  entryTwo: '018f0000-0000-7000-8000-000000000957',
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
    recursiveScanning: true, isGlobal: false, extensions: {},
    compatibility: {
      sourceFormat: 'worldbook:st-native', rawPayload: { hidden: 'RAW-WORLDBOOK-SENTINEL' },
      unknownFields: { vendor: 'WORLDBOOK-SECRET' }, compatWarnings: ['future_book'], parserVersion: '1',
    },
  });
  const entry = {
    worldbookId: ids.worldbook, keys: ['archive'], content: 'The archive remembers.', sourceUid: 42, sourceOrdinal: 0,
    compatibility: {
      sourceFormat: 'worldbook-entry:st-native', rawPayload: { hidden: 'RAW-ENTRY-SENTINEL' },
      unknownFields: { vendor: 'ENTRY-SECRET' }, compatWarnings: ['future_entry'], parserVersion: '1',
    },
  };
  repositories.worldbookEntries.create({ id: ids.entry, ...entry, order: 10 });
  repositories.worldbookEntries.create({ id: ids.entryTwo, ...entry, sourceUid: 'second', sourceOrdinal: 1, order: 20 });
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories };
}

describe('sanitized manager APIs', () => {
  it('returns bounded safe DTOs without raw compatibility, secret, path, or preset marker values', async () => {
    const { app } = await context();
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/characters' }),
      app.inject({ method: 'GET', url: `/api/characters/${ids.character}` }),
      app.inject({ method: 'GET', url: '/api/personas' }),
      app.inject({ method: 'GET', url: `/api/personas/${ids.persona}` }),
      app.inject({ method: 'GET', url: '/api/presets' }),
      app.inject({ method: 'GET', url: `/api/presets/${ids.preset}` }),
      app.inject({ method: 'GET', url: '/api/worldbooks' }),
      app.inject({ method: 'GET', url: `/api/worldbooks/${ids.worldbook}` }),
    ]);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const serialized = responses.map((response) => response.body).join('\n');
    for (const forbidden of [
      'rawPayload', 'unknownFields', 'avatar-secret.png', 'RAW-CHARACTER-SENTINEL', 'CHARACTER-SECRET',
      'RAW-PERSONA-SENTINEL', 'RAW-PRESET-SENTINEL', 'PRESET-SECRET', 'PRESET-VENDOR-SECRET', 'INTERNAL-MARKER',
      '__tavernnextPresetSource', 'RAW-WORLDBOOK-SENTINEL', 'WORLDBOOK-SECRET', 'RAW-ENTRY-SENTINEL', 'ENTRY-SECRET',
    ]) expect(serialized).not.toContain(forbidden);
    expect(responses[1]!.json()).toMatchObject({
      name: 'Aster', avatarUrl: `/api/characters/${ids.character}/avatar`,
      compatibilitySummary: { sourceFormat: 'st-character-v3', warnings: ['future_character'], unknownFieldCount: 1 },
    });
    expect(responses[5]!.json()).toMatchObject({
      name: 'Role Chat', kind: 'chat', settings: { temperature: 0.7 },
      compatibilitySummary: { sourceFormat: 'preset:chat', warnings: ['provider_field_preserved_not_executable'] },
    });
    expect(responses[7]!.json()).toMatchObject({
      name: 'Archive Lore', entries: [
        { id: ids.entry, sourceUid: 42, sourceOrdinal: 0, compatibilitySummary: { warnings: ['future_entry'] } },
        { id: ids.entryTwo, sourceUid: 'second', sourceOrdinal: 1 },
      ],
    });
  });

  it('accepts explicit revisioned patches, rejects private or mistyped fields, and preserves state on conflicts', async () => {
    const { app, repositories } = await context();
    const invalidCharacter = await app.inject({
      method: 'PATCH', url: `/api/characters/${ids.character}`,
      payload: { revision: 0, patch: { description: 'Allowed', compatibility: { rawPayload: 'forged' } } },
    });
    expect(invalidCharacter.statusCode).toBe(400);
    expect(repositories.characters.get(ids.character)?.description).toBe('Archivist');

    const updated = await app.inject({
      method: 'PATCH', url: `/api/characters/${ids.character}`,
      payload: { revision: 0, patch: { description: 'Edited', alternateGreetings: ['One', 'Two'] } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 1, description: 'Edited', alternateGreetings: ['One', 'Two'] });
    const stale = await app.inject({
      method: 'PATCH', url: `/api/characters/${ids.character}`,
      payload: { revision: 0, patch: { description: 'Stale overwrite' } },
    });
    expect(stale.statusCode).toBe(409);
    expect(repositories.characters.get(ids.character)?.description).toBe('Edited');

    const unlinked = await app.inject({
      method: 'PATCH', url: `/api/characters/${ids.character}`,
      payload: { revision: 1, patch: { worldbookId: null } },
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json()).not.toHaveProperty('worldbookId');
    expect(repositories.characters.get(ids.character)?.worldbookId).toBeUndefined();

    const invalidPreset = await app.inject({
      method: 'PATCH', url: `/api/presets/${ids.preset}`,
      payload: { revision: 0, patch: { settings: { temperature: 'hot' } } },
    });
    expect(invalidPreset.statusCode).toBe(400);
    expect(repositories.presets.get(ids.preset)?.settings.temperature).toBe(0.7);

    const invalidEntry = await app.inject({
      method: 'PATCH', url: `/api/worldbooks/${ids.worldbook}/entries/${ids.entry}`,
      payload: { revision: 0, patch: { content: 'Allowed', sourceUid: 'forged', sourceOrdinal: 99 } },
    });
    expect(invalidEntry.statusCode).toBe(400);
    expect(repositories.worldbookEntries.get(ids.entry)?.content).toBe('The archive remembers.');
  });

  it('keeps Persona default transitions and Worldbook reorder operations atomic', async () => {
    const { app, repositories } = await context();
    const selected = await app.inject({
      method: 'PATCH', url: `/api/personas/${ids.personaTwo}`,
      payload: { revision: 0, patch: { isDefault: true } },
    });
    expect(selected.statusCode).toBe(200);
    expect(repositories.personas.list().filter((persona) => persona.isDefault).map((persona) => persona.id)).toEqual([ids.personaTwo]);

    const staleReorder = await app.inject({
      method: 'PUT', url: `/api/worldbooks/${ids.worldbook}/entries/order`,
      payload: { entries: [{ id: ids.entry, revision: 0, order: 20 }, { id: ids.entryTwo, revision: 99, order: 10 }] },
    });
    expect(staleReorder.statusCode).toBe(409);
    expect(repositories.worldbookEntries.listByWorldbookId(ids.worldbook).map((entry) => [entry.id, entry.order])).toEqual([
      [ids.entry, 10], [ids.entryTwo, 20],
    ]);

    const reordered = await app.inject({
      method: 'PUT', url: `/api/worldbooks/${ids.worldbook}/entries/order`,
      payload: { entries: [{ id: ids.entry, revision: 0, order: 20 }, { id: ids.entryTwo, revision: 0, order: 10 }] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(repositories.worldbookEntries.listByWorldbookId(ids.worldbook).map((entry) => [entry.id, entry.order])).toEqual([
      [ids.entry, 20], [ids.entryTwo, 10],
    ]);
  });
});
