import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESTINED_POEM_SCENE_ID } from '../src/scenes/official-package.js';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';
import { capturedProvider, unitTokenizerRuntime } from './prompt-integration-fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((value) => value())); });

async function context(provider = capturedProvider()) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-'));
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    providerClientFactory: () => provider.client,
    tokenizerRuntime: unitTokenizerRuntime(),
  });
  await app.ready();
  cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, repositories };
}

describe('Scene Package API', () => {
  it('installs the signed official Scene and compiles the complete embedded Worldbook', async () => {
    const { app, repositories } = await context();
    const catalog = await app.inject({ method: 'GET', url: '/api/scenes/catalog' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()[0]).toMatchObject({ sceneId: DESTINED_POEM_SCENE_ID, installed: false });

    const installed = await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({
      id: DESTINED_POEM_SCENE_ID,
      conversationCount: 0,
      fullyTrusted: true,
      manifest: { name: '命定之诗与黄昏之歌', serverEntry: 'server/index.mjs' },
    });
    const scene = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    const character = repositories.characters.get(scene.backingCharacterId)!;
    expect(character.worldbookId).toBeDefined();
    expect(repositories.worldbookEntries.listByWorldbookId(character.worldbookId!).length).toBe(469);

    const repeated = await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().archiveDigest).toBe(scene.archiveDigest);
  }, 60_000);

  it('creates isolated saves, snapshots Persona data, patches state, and cascades uninstall', async () => {
    const { app, repositories } = await context();
    await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    const persona = repositories.personas.create({
      id: randomUUID(), name: '见证者', description: '来自旧世界的旅行者。', isDefault: true,
    });
    const create = (name: string, origin: string) => app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: {
        title: `${name}的存档`, personaTemplateId: persona.id,
        playerProfile: { name, description: persona.description }, setup: { origin },
      },
    });
    const firstResponse = await create('艾琳', '梵尼亚');
    const secondResponse = await create('洛恩', '索伦蒂斯王国');
    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    const first = firstResponse.json();
    const second = secondResponse.json();
    expect(first.playerProfile).toMatchObject({ name: '艾琳', sourcePersonaId: persona.id });

    const firstState = (await app.inject({ method: 'GET', url: `/api/conversations/${first.id}/scene-state` })).json();
    const secondState = (await app.inject({ method: 'GET', url: `/api/conversations/${second.id}/scene-state` })).json();
    expect(firstState.value.世界.地点).toBe('梵尼亚');
    expect(secondState.value.世界.地点).toBe('索伦蒂斯王国');

    const patched = await app.inject({
      method: 'PATCH', url: `/api/conversations/${first.id}/scene-state`,
      payload: { revision: firstState.revision, patch: [{ op: 'replace', path: '/命运点数', value: 3 }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().value.命运点数).toBe(3);
    const unchanged = (await app.inject({ method: 'GET', url: `/api/conversations/${second.id}/scene-state` })).json();
    expect(unchanged.value.命运点数).toBe(0);

    const scene = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    const removed = await app.inject({
      method: 'DELETE', url: `/api/scenes/${scene.id}`,
      payload: { revision: scene.revision, cascade: true },
    });
    expect(removed.statusCode).toBe(200);
    expect(repositories.installedScenes.get(scene.id)).toBeUndefined();
    expect(repositories.conversations.get(first.id)).toBeUndefined();
    expect(repositories.conversations.get(second.id)).toBeUndefined();
  }, 60_000);

  it('uses the Scene recipe and commits a model JSON Patch only to the active save', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: '钟声落下，命运向前推进。<UpdateVariable><JSONPatch>[{"op":"replace","path":"/命运点数","value":7}]</JSONPatch></UpdateVariable>' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await context(provider);
    await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    const connection = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Mock', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mock', apiMode: 'chat',
    });
    expect(repositories.globalGenerationConfig.update(0, { providerId: connection.id })).toMatchObject({ ok: true });
    const created = await app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: { title: '推进测试', playerProfile: { name: '旅人', description: '' }, setup: { origin: '梵尼亚' } },
    });
    const conversation = created.json();
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/generations`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: '继续前进' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: completed');
    const state = repositories.conversationSceneStates.getByConversationId(conversation.id)!;
    expect(state.value.命运点数).toBe(7);
    const assistant = repositories.messages.listByConversationId(conversation.id).at(-1)!;
    const variant = repositories.messageVariants.get(assistant.activeVariantId!)!;
    expect(variant.content).toBe('钟声落下，命运向前推进。');
    expect(provider.chat).toHaveLength(1);
    expect(JSON.stringify(provider.chat[0])).toContain('<scene_state>');
  }, 60_000);
});
