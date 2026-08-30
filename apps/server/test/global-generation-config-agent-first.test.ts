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
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-agent-first-config-'));
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

describe('Agent-first global generation configuration API', () => {
  it('accepts only an Agent-capable Provider and Chat template', async () => {
    const { app, repositories } = await context();
    const provider = repositories.providerProfiles.create({
      id: '018f0000-0000-7000-8000-000000000111', name: 'Agent Provider',
      baseUrl: 'https://provider.example/v1', model: 'agent-model', apiMode: 'chat', toolCalls: true,
    });
    const chat = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000112', name: 'Chat template', kind: 'chat', settings: {},
    });
    const text = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000113', name: 'Text template', kind: 'text', settings: {},
    });
    const incapableProvider = repositories.providerProfiles.create({
      id: '018f0000-0000-7000-8000-000000000114', name: 'Chat-only Provider',
      baseUrl: 'https://chat-only.example/v1', model: 'chat-model', apiMode: 'chat', toolCalls: false,
    });

    const saved = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 0, patch: { providerId: provider.id, chatPresetId: chat.id } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      revision: 1, providerId: provider.id, chatPresetId: chat.id,
      textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null,
    });

    const companion = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 1, patch: { textPresetId: text.id } },
    });
    expect(companion.statusCode).toBe(400);
    expect(companion.json()).toEqual({ error: 'invalid_request' });

    const wrongKind = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 1, patch: { chatPresetId: text.id } },
    });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json()).toEqual({ error: 'invalid_selection' });

    const incapable = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: { revision: 1, patch: { providerId: incapableProvider.id } },
    });
    expect(incapable.statusCode).toBe(400);
    expect(incapable.json()).toEqual({ error: 'model_not_agent_capable' });
  });

  it('allows legacy companion fields to be cleared but never repopulated', async () => {
    const { app, repositories } = await context();
    const legacyText = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000121', name: 'Legacy companion', kind: 'text', settings: {},
    });
    const legacyContext = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000122', name: 'Legacy context', kind: 'context', settings: {},
    });
    const legacyInstruct = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000123', name: 'Legacy instruct', kind: 'instruct', settings: {},
    });
    const legacySystem = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000000124', name: 'Legacy system', kind: 'system', settings: {},
    });
    expect(repositories.globalGenerationConfig.update(0, {
      textPresetId: legacyText.id,
      contextPresetId: legacyContext.id,
      instructPresetId: legacyInstruct.id,
      systemPresetId: legacySystem.id,
    }).ok).toBe(true);

    const cleared = await app.inject({
      method: 'PATCH', url: '/api/settings/generation',
      payload: {
        revision: 1,
        patch: { textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null },
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null,
    });
  });
});
