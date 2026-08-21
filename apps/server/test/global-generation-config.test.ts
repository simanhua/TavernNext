import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-global-generation-config-'));
  directories.push(directory);
  const path = join(directory, 'test.sqlite');
  const database = createDatabase(path);
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: path },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories };
}

describe('global generation configuration API', () => {
  it('retains the selected configuration after closing and reopening SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-global-generation-config-reopen-'));
    directories.push(directory);
    const path = join(directory, 'test.sqlite');
    const database = createDatabase(path);
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const providerId = '018f0000-0000-7000-8000-000000000121';
    repositories.providerProfiles.create({
      id: providerId, name: 'Persistent', baseUrl: 'https://persistent.example/v1', model: 'model', apiMode: 'chat',
    });
    expect(repositories.globalGenerationConfig.update(0, { providerId })).toMatchObject({
      ok: true, value: { revision: 1, providerId },
    });
    database.close();

    const reopened = createDatabase(path);
    migrateDatabase(reopened);
    expect(createRepositories(reopened, TEST_REPOSITORY_OPTIONS).globalGenerationConfig.get()).toMatchObject({
      revision: 1, providerId,
    });
    reopened.close();
  });

  it('persists valid Provider and Preset selections behind one revision', async () => {
    const { app, repositories } = await context();
    const provider = repositories.providerProfiles.create({
      id: '018f0000-0000-7000-8000-000000000101',
      name: 'Primary', baseUrl: 'https://provider.example/v1', model: 'model', apiMode: 'chat',
    });
    const chat = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000102', name: 'Chat', kind: 'chat', settings: { prompts: [], prompt_order: [] },
    });
    const text = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000103', name: 'Text', kind: 'text', settings: {},
    });
    const contextPreset = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000104', name: 'Context', kind: 'context', settings: { story_string: '{{description}}' },
    });
    const instruct = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000105', name: 'Instruct', kind: 'instruct',
      settings: { input_sequence: '<u>', output_sequence: '<a>', system_sequence: '<s>' },
    });
    const system = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000106', name: 'System', kind: 'system', settings: { content: 'System', post_history: '' },
    });

    const empty = await app.inject({ method: 'GET', url: '/api/settings/generation' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      revision: 0,
      providerId: null,
      chatPresetId: null,
      textPresetId: null,
      contextPresetId: null,
      instructPresetId: null,
      systemPresetId: null,
    });

    const saved = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: {
        revision: 0,
        patch: {
          providerId: provider.id,
          chatPresetId: chat.id,
          textPresetId: text.id,
          contextPresetId: contextPreset.id,
          instructPresetId: instruct.id,
          systemPresetId: system.id,
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 1, providerId: provider.id, chatPresetId: chat.id, textPresetId: text.id });
    expect((await app.inject({ method: 'GET', url: '/api/settings/generation' })).json()).toEqual(saved.json());

    const stale = await app.inject({
      method: 'PATCH', url: '/api/settings/generation', payload: { revision: 0, patch: { providerId: null } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'conflict' });
  });

  it('rejects missing or wrong-kind selections and clears deleted selections', async () => {
    const { app, repositories } = await context();
    const provider = repositories.providerProfiles.create({
      id: '018f0000-0000-7000-8000-000000000111',
      name: 'Primary', baseUrl: 'https://provider.example/v1', model: 'model', apiMode: 'chat',
    });
    const chat = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000112', name: 'Chat', kind: 'chat', settings: { prompts: [], prompt_order: [] },
    });

    const wrongKind = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 0, patch: { textPresetId: chat.id } },
    });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json()).toEqual({ error: 'invalid_selection' });

    const missing = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 0, patch: { providerId: '018f0000-0000-7000-8000-000000000999' } },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'invalid_selection' });

    const missingPrimary = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 0, patch: { providerId: provider.id } },
    });
    expect(missingPrimary.statusCode).toBe(400);
    expect(missingPrimary.json()).toEqual({ error: 'invalid_selection' });

    const saved = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 0, patch: { providerId: provider.id, chatPresetId: chat.id } },
    });
    expect(saved.statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: `/api/providers/${provider.id}?revision=0` })).statusCode).toBe(204);
    let current = (await app.inject({ method: 'GET', url: '/api/settings/generation' })).json();
    expect(current).toMatchObject({
      revision: 2,
      providerId: null,
      chatPresetId: chat.id,
      selectionNotice: { kind: 'provider', deletedId: provider.id },
    });

    expect((await app.inject({ method: 'DELETE', url: `/api/presets/${chat.id}?revision=0` })).statusCode).toBe(204);
    current = (await app.inject({ method: 'GET', url: '/api/settings/generation' })).json();
    expect(current).toMatchObject({
      revision: 3,
      providerId: null,
      chatPresetId: null,
      selectionNotice: { kind: 'preset', deletedId: chat.id },
    });
  });

  it('resolves only the Provider-mode primary Preset resources and excludes companions', async () => {
    const { app, repositories } = await context();
    const provider = repositories.providerProfiles.create({
      id: '018f0000-0000-7000-8000-000000000131', name: 'Mode owner',
      baseUrl: 'https://provider.example/v1', model: 'model', apiMode: 'chat',
    });
    const chat = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000132', name: 'Chat primary', kind: 'chat',
      settings: { prompts: [], prompt_order: [] },
    });
    const text = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000133', name: 'Text primary', kind: 'text', settings: {},
    });
    const companion = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000134', name: 'Context companion', kind: 'context',
      settings: { story_string: '{{description}}' },
    });
    for (const [owner, name] of [[chat.id, 'chat-only'], [text.id, 'text-only'], [companion.id, 'companion-must-not-appear']] as const) {
      repositories.extensionAssets.create({
        id: crypto.randomUUID(), ownerKind: 'preset', ownerId: owner, kind: 'regex', sourceKey: name,
        ordinal: 0, enabled: true,
        payload: { id: name, scriptName: name, findRegex: '/x/g', replaceString: 'y' },
      });
    }
    expect(repositories.globalGenerationConfig.update(0, {
      providerId: provider.id, chatPresetId: chat.id, textPresetId: text.id, contextPresetId: companion.id,
    })).toMatchObject({ ok: true });

    let active = (await app.inject({ method: 'GET', url: '/api/settings/generation/active-extension-resources' })).json();
    expect(active).toMatchObject({
      mode: 'chat', primaryPreset: { id: chat.id, kind: 'chat' },
      attachedExtensions: { resources: [{ sourceKey: 'chat-only' }] },
    });
    expect(JSON.stringify(active)).not.toContain('text-only');
    expect(JSON.stringify(active)).not.toContain('companion-must-not-appear');

    expect(repositories.providerProfiles.update(provider.id, provider.revision, { apiMode: 'text' })).toMatchObject({ ok: true });
    active = (await app.inject({ method: 'GET', url: '/api/settings/generation/active-extension-resources' })).json();
    expect(active).toMatchObject({
      mode: 'text', primaryPreset: { id: text.id, kind: 'text' },
      attachedExtensions: { resources: [{ sourceKey: 'text-only' }] },
    });
    expect(JSON.stringify(active)).not.toContain('chat-only');
    expect(JSON.stringify(active)).not.toContain('companion-must-not-appear');
  });
});
