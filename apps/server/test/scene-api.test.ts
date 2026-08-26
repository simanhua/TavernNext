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
import { capturedProvider, queuedCapturedProvider, unitTokenizerRuntime } from './prompt-integration-fixtures.js';

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
  it('installs the trusted built-in Scene and compiles the complete embedded Worldbook', async () => {
    const { app, repositories } = await context();
    const catalog = await app.inject({ method: 'GET', url: '/api/scenes/catalog' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()[0]).toMatchObject({ sceneId: DESTINED_POEM_SCENE_ID, installed: false });

    const installed = await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({
      id: DESTINED_POEM_SCENE_ID,
      coverUrl: `/api/scenes/${DESTINED_POEM_SCENE_ID}/assets/content/cover.png`,
      conversationCount: 0,
      fullyTrusted: true,
      manifest: {
        name: '命定之诗与黄昏之歌',
        version: '2.7.0',
        serverEntry: 'server/index.mjs',
        coverPath: 'content/cover.png',
      },
    });
    const cover = await app.inject({
      method: 'GET', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/assets/content/cover.png`,
    });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toBe('image/png');
    expect(cover.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(cover.rawPayload.includes(Buffer.from('chara'))).toBe(false);
    expect(cover.rawPayload.includes(Buffer.from('ccv3'))).toBe(false);
    const refreshedCatalog = await app.inject({ method: 'GET', url: '/api/scenes/catalog' });
    expect(refreshedCatalog.json()[0]).toMatchObject({
      sceneId: DESTINED_POEM_SCENE_ID,
      installed: true,
      coverUrl: `/api/scenes/${DESTINED_POEM_SCENE_ID}/assets/content/cover.png`,
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

    const installedScene = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    const template = repositories.presets.get(installedScene.backingPresetId!)!;
    const firstAgentResponse = await app.inject({
      method: 'GET', url: `/api/conversations/${first.id}/agent-configuration`,
    });
    const secondAgentResponse = await app.inject({
      method: 'GET', url: `/api/conversations/${second.id}/agent-configuration`,
    });
    expect(firstAgentResponse.statusCode).toBe(200);
    expect(secondAgentResponse.statusCode).toBe(200);
    expect(firstAgentResponse.json()).toMatchObject({
      revision: 0,
      conversationId: first.id,
      sourcePresetId: template.id,
      sourcePresetRevision: template.revision,
      name: template.name,
      settings: template.settings,
    });
    expect(firstAgentResponse.json()).not.toHaveProperty('extensions');
    expect(firstAgentResponse.json()).not.toHaveProperty('attachedExtensions');
    expect(secondAgentResponse.json()).toMatchObject({
      revision: 0,
      conversationId: second.id,
      sourcePresetId: template.id,
      sourcePresetRevision: template.revision,
      name: template.name,
      settings: template.settings,
    });
    const editedAgent = await app.inject({
      method: 'PATCH', url: `/api/conversations/${first.id}/agent-configuration`,
      payload: { revision: 0, patch: { settings: { ...template.settings, temperature: 0.2 } } },
    });
    expect(editedAgent.statusCode).toBe(200);
    expect(editedAgent.json()).toMatchObject({ revision: 1, settings: { temperature: 0.2 } });
    expect((await app.inject({
      method: 'GET', url: `/api/conversations/${second.id}/agent-configuration`,
    })).json()).toMatchObject({ revision: 0, settings: template.settings });
    expect(repositories.presets.get(template.id)).toEqual(template);

    const updatedTemplate = repositories.presets.update(template.id, template.revision, {
      name: '新版场景文风',
      settings: { ...template.settings, temperature: 0.8 },
    });
    expect(updatedTemplate.ok).toBe(true);
    expect((await app.inject({
      method: 'GET', url: `/api/conversations/${first.id}/agent-configuration`,
    })).json()).toMatchObject({
      revision: 1,
      sourcePresetRevision: 0,
      name: template.name,
      settings: { temperature: 0.2 },
    });
    const synchronized = await app.inject({
      method: 'POST', url: `/api/conversations/${first.id}/agent-configuration/sync`,
      payload: { revision: 1 },
    });
    expect(synchronized.statusCode).toBe(200);
    expect(synchronized.json()).toMatchObject({
      revision: 2,
      sourcePresetId: template.id,
      sourcePresetRevision: 1,
      name: '新版场景文风',
      settings: { temperature: 0.8 },
    });

    const alternative = repositories.presets.create({
      id: randomUUID(), name: '冷峻叙事', kind: 'chat',
      settings: { prompts: [], prompt_order: [], temperature: 0.4 },
    });
    const replaced = await app.inject({
      method: 'POST', url: `/api/conversations/${second.id}/agent-configuration/replace`,
      payload: { revision: 0, presetId: alternative.id },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      revision: 1,
      sourcePresetId: alternative.id,
      sourcePresetRevision: 0,
      name: alternative.name,
      settings: alternative.settings,
    });
    const textTemplate = repositories.presets.create({
      id: randomUUID(), name: 'Text only', kind: 'text', settings: {},
    });
    const wrongKind = await app.inject({
      method: 'POST', url: `/api/conversations/${second.id}/agent-configuration/replace`,
      payload: { revision: 1, presetId: textTemplate.id },
    });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json()).toEqual({ error: 'invalid_preset' });

    const firstState = (await app.inject({ method: 'GET', url: `/api/conversations/${first.id}/scene-state` })).json();
    const secondState = (await app.inject({ method: 'GET', url: `/api/conversations/${second.id}/scene-state` })).json();
    expect(firstState.value.世界.地点).toBe('梵尼亚');
    expect(secondState.value.世界.地点).toBe('索伦蒂斯王国');

    const patched = await app.inject({
      method: 'PATCH', url: `/api/conversations/${first.id}/scene-state`,
      payload: { revision: firstState.revision, patch: [{ op: 'replace', path: '/命运点数', value: 3 }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().state.value.命运点数).toBe(3);
    expect(patched.json().failures).toEqual([]);
    expect(repositories.sceneStateTransitions.listByConversationId(first.id)).toHaveLength(1);
    const unconstrained = await app.inject({
      method: 'PATCH', url: `/api/conversations/${first.id}/scene-state`,
      payload: { revision: patched.json().state.revision, patch: [{ op: 'replace', path: '/命运点数', value: -1 }] },
    });
    expect(unconstrained.statusCode).toBe(200);
    expect(unconstrained.json().state.value.命运点数).toBe(-1);
    const granted = await app.inject({
      method: 'PATCH', url: `/api/conversations/${first.id}/scene-state`,
      payload: { revision: unconstrained.json().state.revision, patch: [{ op: 'replace', path: '/主角/属性点', value: 1 }] },
    });
    const allocated = await app.inject({
      method: 'PATCH', url: `/api/conversations/${first.id}/scene-state`,
      payload: {
        revision: granted.json().state.revision,
        patch: [
          { op: 'delta', path: '/主角/属性点', value: -1 },
          { op: 'delta', path: '/主角/属性/力量', value: 1 },
        ],
      },
    });
    expect(allocated.statusCode).toBe(200);
    expect(allocated.json().state.value.主角).toMatchObject({ 属性点: 0, 属性: { 力量: 1 } });
    expect(repositories.sceneStateTransitions.listByConversationId(first.id).map((item) => item.sourceKind))
      .toEqual(['sdk-patch', 'sdk-patch', 'sdk-patch', 'sdk-patch']);
    const unchanged = (await app.inject({ method: 'GET', url: `/api/conversations/${second.id}/scene-state` })).json();
    expect(unchanged.value.命运点数).toBe(0);
    const secondMessages = repositories.messages.listByConversationId(second.id);
    const secondVariants = repositories.messageVariants.listByConversationId(second.id);
    const deletedSave = await app.inject({
      method: 'DELETE', url: `/api/conversations/${second.id}?revision=${second.revision}`,
    });
    expect(deletedSave.statusCode).toBe(204);
    expect(repositories.conversations.get(second.id)).toBeUndefined();
    expect(repositories.personas.get(second.personaId)).toBeUndefined();
    expect(repositories.conversationSceneStates.getByConversationId(second.id)).toBeUndefined();
    expect(repositories.saveAgentConfigurations.getByConversationId(second.id)).toBeUndefined();
    expect(repositories.sceneStateTransitions.listByConversationId(second.id)).toEqual([]);
    expect(secondMessages.every((message) => repositories.messages.get(message.id) === undefined)).toBe(true);
    expect(secondVariants.every((variant) => repositories.messageVariants.get(variant.id) === undefined)).toBe(true);
    expect(repositories.conversations.get(first.id)).toBeDefined();

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

  it('does not execute prose-embedded state commands after the official Scene becomes Agent-first', async () => {
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
      payload: {
        conversationRevision: conversation.revision,
        mode: 'normal',
        userText: '继续前进',
        scenePromptAdditions: [{ role: 'system', content: 'MALICIOUS-CLIENT-INJECTION' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: completed');
    const state = repositories.conversationSceneStates.getByConversationId(conversation.id)!;
    expect(state.value.命运点数).toBe(0);
    const assistant = repositories.messages.listByConversationId(conversation.id).at(-1)!;
    const variant = repositories.messageVariants.get(assistant.activeVariantId!)!;
    expect(variant.content).toContain('<UpdateVariable>');
    expect(variant.diagnostics).toEqual([]);
    expect(repositories.sceneStateTransitions.getBySource('message-variant', variant.id)).toBeUndefined();
    expect(state.headTransitionId).toBeNull();
    expect(provider.chat).toHaveLength(1);
    const prompt = JSON.stringify(provider.chat[0]);
    expect(prompt.match(/<scene_state>/g)).toHaveLength(1);
    expect(prompt).toContain('保持阿斯塔利亚世界观一致');
    expect(prompt).not.toContain('Always append exactly one legacy MVU block');
    expect(prompt).not.toContain('Use an empty [] operation list');
    expect(prompt).not.toContain('Use only replace, delta, insert, remove, or move operations');
    expect(prompt).not.toContain('ONLY permitted to output the variable update content');
    expect(prompt).not.toContain('MALICIOUS-CLIENT-INJECTION');
  }, 60_000);

  it('keeps valid narrative and reports an invalid model state patch without changing Scene State', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: '风仍在吹。<UpdateVariable><JSONPatch>{not-json}</JSONPatch></UpdateVariable>' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await context(provider);
    await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    const connection = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Mock', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mock', apiMode: 'chat',
    });
    repositories.globalGenerationConfig.update(0, { providerId: connection.id });
    const created = (await app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: { title: '诊断测试', playerProfile: { name: '旅人', description: '' }, setup: { origin: '梵尼亚' } },
    })).json();
    const before = repositories.conversationSceneStates.getByConversationId(created.id)!;
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.id}/generations`,
      payload: { conversationRevision: created.revision, mode: 'normal', userText: '继续' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: completed');
    const after = repositories.conversationSceneStates.getByConversationId(created.id)!;
    expect(after.revision).toBe(before.revision);
    expect(after.value).toEqual(before.value);
    expect(repositories.sceneStateTransitions.listByConversationId(created.id)).toEqual([]);
    const assistant = repositories.messages.listByConversationId(created.id).at(-1)!;
    const variant = repositories.messageVariants.get(assistant.activeVariantId!)!;
    expect(variant.content).toContain('<UpdateVariable>');
    expect(variant.diagnostics).toEqual([]);
  }, 60_000);

  it('keeps narrative and diagnoses a missing mandatory MVU block', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: '你收起新获得的药水，但没有输出变量块。' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await context(provider);
    await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    const connection = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Mock', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mock', apiMode: 'chat',
    });
    repositories.globalGenerationConfig.update(0, { providerId: connection.id });
    const created = (await app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: { title: '缺失变量块测试', playerProfile: { name: '旅人', description: '' }, setup: { origin: '梵尼亚' } },
    })).json();
    const before = repositories.conversationSceneStates.getByConversationId(created.id)!;
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.id}/generations`,
      payload: { conversationRevision: created.revision, mode: 'normal', userText: '拾取药水' },
    });
    expect(response.statusCode).toBe(200);
    const after = repositories.conversationSceneStates.getByConversationId(created.id)!;
    expect(after.revision).toBe(before.revision);
    const assistant = repositories.messages.listByConversationId(created.id).at(-1)!;
    const variant = repositories.messageVariants.get(assistant.activeVariantId!)!;
    expect(variant.content).toBe('你收起新获得的药水，但没有输出变量块。');
    expect(variant.diagnostics).toEqual([]);
  }, 60_000);

  it('keeps a legacy MVU wrapper inert instead of mutating canonical Scene State', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: '命运发生变化。<UpdateVariable><Analysis>Apply the available changes.</Analysis><JSONPatch>[{"op":"replace","path":"/命运点数","value":8},{"op":"delta","path":"/不存在","value":1},{"op":"insert","path":"/主角/技能/直觉","value":{"等级":1}}]</JSONPatch></UpdateVariable>' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await context(provider);
    await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    const connection = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Mock', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mock', apiMode: 'chat',
    });
    repositories.globalGenerationConfig.update(0, { providerId: connection.id });
    const created = (await app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: { title: '部分更新测试', playerProfile: { name: '旅人', description: '' }, setup: { origin: '梵尼亚' } },
    })).json();
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${created.id}/generations`,
      payload: { conversationRevision: created.revision, mode: 'normal', userText: '继续' },
    });
    expect(response.statusCode).toBe(200);
    const state = repositories.conversationSceneStates.getByConversationId(created.id)!;
    expect(state.value).toMatchObject({ 命运点数: 0, 主角: { 技能: {} } });
    const assistant = repositories.messages.listByConversationId(created.id).at(-1)!;
    const variant = repositories.messageVariants.get(assistant.activeVariantId!)!;
    expect(variant.content).toContain('<UpdateVariable>');
    expect(variant.diagnostics).toEqual([]);
    expect(repositories.sceneStateTransitions.getBySource('message-variant', variant.id)).toBeUndefined();
  }, 60_000);

  it('does not synthesize Variant state anchors from legacy prose generations', async () => {
    const provider = queuedCapturedProvider([
      [
        { type: 'delta', text: '第一条命运。<UpdateVariable><JSONPatch>[{"op":"replace","path":"/命运点数","value":1}]</JSONPatch></UpdateVariable>' },
        { type: 'completed', finishReason: 'stop' },
      ],
      [
        { type: 'delta', text: '第二条命运。<UpdateVariable><JSONPatch>[{"op":"replace","path":"/命运点数","value":2}]</JSONPatch></UpdateVariable>' },
        { type: 'completed', finishReason: 'stop' },
      ],
    ]);
    const { app, repositories } = await context(provider);
    await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    const connection = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Mock', baseUrl: 'http://127.0.0.1:9999/v1', model: 'mock', apiMode: 'chat',
    });
    repositories.globalGenerationConfig.update(0, { providerId: connection.id });
    const conversation = (await app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: { title: '分支测试', playerProfile: { name: '旅人', description: '' }, setup: { origin: '梵尼亚' } },
    })).json();
    await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/generations`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: '开始' },
    });
    const afterFirst = repositories.conversations.get(conversation.id)!;
    await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/generations`,
      payload: { conversationRevision: afterFirst.revision, mode: 'swipe' },
    });
    const assistant = repositories.messages.listByConversationId(conversation.id).at(-1)!;
    const variants = repositories.messageVariants.listByMessageId(assistant.id);
    expect(variants).toHaveLength(2);
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)!.value.命运点数).toBe(0);
    const switched = await app.inject({
      method: 'PUT', url: `/api/messages/${assistant.id}/active-variant`,
      payload: { revision: assistant.revision, variantId: variants[0]!.id },
    });
    expect(switched.statusCode).toBe(200);
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)!.value.命运点数).toBe(0);
    const current = repositories.conversationSceneStates.getByConversationId(conversation.id)!;
    const descendant = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversation.id}/scene-state`,
      payload: { revision: current.revision, patch: [{ op: 'replace', path: '/命运点数', value: 9 }] },
    });
    expect(descendant.statusCode).toBe(200);
    const latestMessage = repositories.messages.get(assistant.id)!;
    const blocked = await app.inject({
      method: 'PUT', url: `/api/messages/${assistant.id}/active-variant`,
      payload: { revision: latestMessage.revision, variantId: variants[1]!.id },
    });
    expect(blocked.statusCode).toBe(200);
    const deleted = await app.inject({
      method: 'DELETE', url: `/api/messages/${assistant.id}?revision=${latestMessage.revision}`,
    });
    expect(deleted.statusCode).toBe(409);
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)!.value.命运点数).toBe(9);
    expect(repositories.sceneStateTransitions.listByConversationId(conversation.id)).toHaveLength(1);
  }, 60_000);
});
