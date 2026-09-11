import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { SCENE_LAB_SCENE_ID } from '../src/scenes/official-package.js';
import type { SaveAgentRuntime } from '../src/services/save-agent-runtime.js';
import { createGenerationService } from '../src/services/generation-service.js';
import { createSaveMemoryService } from '../src/services/save-memory-service.js';
import { createSceneService } from '../src/scenes/scene-service.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-retired-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const start = vi.fn<SaveAgentRuntime['start']>(async () => ({
    ok: true, generationId: 'current-save-generation',
    events: (async function* () {
      yield { type: 'started', generationId: 'current-save-generation' } as const;
      yield { type: 'delta', text: 'Current Scene Save' } as const;
      yield { type: 'completed', finishReason: 'stop' } as const;
    })(),
  }));
  const runtime: SaveAgentRuntime = {
    start,
    regenerateActionOptions: async () => ({ ok: false, reason: 'not_found' }),
    cancel: () => false,
    isConversationActive: () => false,
  };
  const app = createApp({
    database, saveAgentRuntime: runtime, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY, loggerStream: { write() {} },
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: database.path },
  });
  apps.push(app);
  await app.ready();
  const installed = await app.inject({ method: 'POST', url: '/api/scenes/' + SCENE_LAB_SCENE_ID + '/install' });
  expect(installed.statusCode).toBe(201);
  const created = await app.inject({
    method: 'POST', url: '/api/scenes/' + SCENE_LAB_SCENE_ID + '/conversations',
    payload: { title: 'Current Save', playerProfile: { name: 'Traveler', description: 'A visitor' }, setup: { experimentName: 'Contract' } },
  });
  expect(created.statusCode).toBe(201);
  const save = repositories.conversations.get(created.json().id)!;
  return { app, database, directory, repositories, save, start };
}

describe('retired APIs and Scene Save identity', () => {
  it('keeps old asset APIs absent even when their former environment switch is true', async () => {
    vi.stubEnv('TAVERNNEXT_ENABLE_LEGACY_ASSET_API', 'true');
    const { app, save, repositories } = await context();
    const presetId = repositories.installedScenes.get(SCENE_LAB_SCENE_ID)!.backingPresetId!;
    const targets = [
      ['POST', '/api/imports/inspect'],
      ['POST', '/api/imports/token/commit'],
      ['GET', '/api/characters'],
      ['POST', '/api/characters'],
      ['GET', '/api/characters/' + save.characterId + '/export'],
      ['GET', '/api/characters/' + save.characterId + '/avatar'],
      ['PUT', '/api/personas/' + save.personaId + '/avatar'],
      ['GET', '/api/worldbooks'],
      ['POST', '/api/worldbooks'],
      ['GET', '/api/worldbooks/' + randomUUID() + '/export'],
      ['GET', '/api/presets/' + presetId + '/export'],
      ['GET', '/api/extension-assets'],
      ['PUT', '/api/extension-assets'],
      ['GET', '/api/runtime-states/conversation/' + save.id],
      ['GET', '/api/extension-trust/character/' + save.characterId],
      ['POST', '/api/conversations/' + save.id + '/extension-runtime/rpc'],
      ['GET', '/api/conversations/' + save.id + '/interactive-resource'],
      ['POST', '/api/conversations/' + save.id + '/interactive-actions'],
      ['GET', '/api/settings/generation/active-resource-context'],
      ['GET', '/api/settings/generation/active-extension-resources'],
      ['POST', '/api/conversations'],
    ] as const;
    for (const [method, url] of targets) {
      const response = await app.inject({ method, url, ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}) });
      expect(response.statusCode, method + ' ' + url).toBe(404);
    }
  });

  it('keeps historical scene-less records stored while excluding their API access and execution', async () => {
    const { app, database, directory, repositories, save, start } = await context();
    const legacy = repositories.conversations.create({
      id: randomUUID(), title: 'Historical chat', characterId: save.characterId, personaId: save.personaId,
    });
    const message = repositories.messages.create({ id: randomUUID(), conversationId: legacy.id, role: 'user', content: 'Old message', activeVariantId: null });
    const memory = repositories.saveMemories.create({
      id: randomUUID(), conversationId: legacy.id, kind: 'episode', tier: 'near', summary: 'Old memory', detail: '',
      entities: [], salience: 0.5, confidence: 0.5, sourceMessageId: null, sourceVariantId: null,
      sourceTransitionId: null, sourceAgentRunId: null, sourceMemoryIds: [], supersedesId: null,
      contentHash: 'a'.repeat(64), tokenCount: 2,
    });
    const oldJob = repositories.memoryJobs.create({
      id: randomUUID(), conversationId: legacy.id, kind: 'extract-turn', status: 'failed',
      attempts: 1, nextAttemptAt: null, payload: {}, lastError: 'historical',
    });
    const pendingOldJob = repositories.memoryJobs.create({
      id: randomUUID(), conversationId: legacy.id, kind: 'extract-turn', status: 'pending',
      attempts: 0, nextAttemptAt: null, payload: {}, lastError: null,
    });
    const currentJob = repositories.memoryJobs.create({
      id: randomUUID(), conversationId: save.id, kind: 'extract-turn', status: 'pending',
      attempts: 0, nextAttemptAt: null, payload: {}, lastError: null,
    });
    const list = await app.inject({ method: 'GET', url: '/api/conversations' });
    expect(list.json().map((value: { id: string }) => value.id)).toEqual([save.id]);
    const actions = [
      { method: 'GET', url: '/api/conversations/' + legacy.id },
      { method: 'GET', url: '/api/conversations/' + legacy.id + '/messages' },
      { method: 'PATCH', url: '/api/conversations/' + legacy.id, payload: { revision: 0, patch: { title: 'Changed' } } },
      { method: 'DELETE', url: '/api/conversations/' + legacy.id + '?revision=0' },
      { method: 'POST', url: '/api/conversations/' + legacy.id + '/generations', payload: { conversationRevision: 0, mode: 'normal', userText: 'Continue' } },
      { method: 'GET', url: '/api/conversations/' + legacy.id + '/memories' },
      { method: 'PATCH', url: '/api/messages/' + message.id, payload: { revision: 0, patch: { content: 'Changed' } } },
      { method: 'PUT', url: '/api/messages/' + message.id + '/active-variant', payload: { revision: 0, variantId: randomUUID() } },
      { method: 'DELETE', url: '/api/messages/' + message.id + '?revision=0' },
      { method: 'PATCH', url: '/api/memories/' + memory.id, payload: { revision: 0, pinned: true } },
      { method: 'GET', url: '/api/development/agent-runs?conversationId=' + legacy.id },
      { method: 'POST', url: '/api/memory-jobs/' + oldJob.id + '/retry' },
    ] as const;
    for (const action of actions) expect((await app.inject(action)).statusCode, action.method + ' ' + action.url).toBe(404);
    expect(start).not.toHaveBeenCalled();
    const sceneService = createSceneService({ database, repositories, dataDir: directory });
    try {
      const service = createGenerationService({ database, repositories, sceneService });
      expect(await service.start({ conversationId: legacy.id, conversationRevision: legacy.revision,
        mode: 'normal', userText: 'Continue' })).toEqual({ ok: false, reason: 'not_found' });
    } finally {
      await sceneService.close();
    }
    expect(repositories.conversations.get(legacy.id)).toEqual(legacy);
    expect(repositories.messages.get(message.id)).toEqual(message);
    expect(repositories.saveMemories.get(memory.id)).toEqual(memory);
    expect(repositories.memoryJobs.listReady(new Date().toISOString(), 1).map((job) => job.id)).toEqual([currentJob.id]);
    const extract = vi.fn(async () => ({ memories: [{
      kind: 'episode' as const, summary: 'Current Save continued.', detail: '', entities: [], salience: 0.5, confidence: 0.5,
    }] }));
    expect(await createSaveMemoryService(repositories).processReadyJobs(extract)).toEqual({ completed: 1, failed: 0 });
    expect(extract).toHaveBeenCalledOnce();
    expect(repositories.memoryJobs.get(oldJob.id)).toEqual(oldJob);
    expect(repositories.memoryJobs.get(pendingOldJob.id)).toEqual(pendingOldJob);

    expect((await app.inject({ method: 'GET', url: '/api/conversations/' + save.id + '/messages' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/conversations/' + save.id + '/memories' })).statusCode).toBe(200);
    const generation = await app.inject({ method: 'POST', url: '/api/conversations/' + save.id + '/generations', payload: {
      conversationRevision: save.revision, mode: 'normal', userText: 'Continue',
    } });
    expect(generation.statusCode).toBe(200);
    expect(generation.payload).toContain('Current Scene Save');
    expect(start).toHaveBeenCalledOnce();
  });

  it('limits public preset management and generation selection to Chat templates', async () => {
    const { app, repositories } = await context();
    const old = repositories.presets.create({ id: randomUUID(), name: 'Old text preset', kind: 'text', settings: {} });
    const listed = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(listed.json().every((value: { kind: string }) => value.kind === 'chat')).toBe(true);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/presets/' + old.id + '?revision=0',
        ...(method === 'PATCH' ? { payload: { revision: 0, patch: { name: 'Changed' } } } : {}),
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/api/presets', payload: {
      id: randomUUID(), name: 'Rejected', kind: 'text', settings: {},
    } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings/generation', payload: {
      revision: repositories.globalGenerationConfig.get().revision, patch: { textPresetId: null },
    } })).statusCode).toBe(400);
    expect(repositories.presets.get(old.id)).toEqual(old);
    const selected = (await app.inject({ method: 'GET', url: '/api/settings/generation' })).json();
    expect(Object.keys(selected).sort()).toEqual(['chatPresetId', 'providerId', 'revision', 'selectionNotice']);
  });
});
