import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import {
  builtInPackage,
  DESTINED_POEM_SCENE_ID,
  officialCatalog,
  SCENE_LAB_SCENE_ID,
} from '../src/scenes/official-package.js';
import { upgradeInstalledOfficialScenes } from '../src/scenes/official-scene-upgrade.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('official Scene registry', () => {
  it('publishes and resolves every registered official Scene Package', () => {
    const catalog = officialCatalog();

    expect(catalog.scenes).toHaveLength(3);
    expect(catalog.scenes.map((scene) => scene.packageUrl)).toEqual([
      'builtin:destined-poem',
      'builtin:scene-lab',
      'builtin:taixu-chronicles',
    ]);
    expect(new Set(catalog.scenes.map((scene) => scene.sceneId)).size).toBe(3);

    for (const entry of catalog.scenes) {
      const first = builtInPackage(entry.packageUrl);
      const second = builtInPackage(entry.packageUrl);
      expect(first?.manifest.id).toBe(entry.sceneId);
      expect(first?.manifest.version).toBe(entry.version);
      expect(first?.digest).toBe(second?.digest);
      expect(first?.bytes).toEqual(second?.bytes);
    }
  }, 60_000);

  it('binds the full Destined Poem preset and preserves its content-addressed binding on package upgrade', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-destined-preset-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();

    expect((await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` })).statusCode).toBe(201);
    const installed = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    const originalPresetId = installed.backingPresetId!;
    const originalPreset = repositories.presets.get(originalPresetId)!;
    expect(originalPreset.name).toBe('命定之诗 Kemini5 3.8 专属预设');
    expect(originalPreset.kind).toBe('chat');
    expect(Array.isArray(originalPreset.settings.prompts) ? originalPreset.settings.prompts : []).toHaveLength(100);
    expect(Array.isArray(originalPreset.settings.prompt_order) ? originalPreset.settings.prompt_order : []).toHaveLength(1);
    expect(originalPreset.settings).not.toHaveProperty('openai_max_context');
    expect(repositories.extensionAssets.listByOwner('preset', originalPresetId)).toHaveLength(12);

    const created = await app.inject({
      method: 'POST',
      url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: {
        title: '原卡完整开局',
        playerProfile: { name: '伊蕾娜', description: '旅行中的见证者' },
        setup: {
          opening: 'custom',
          core: '命定系统-null核心(H一串)',
          dlcKeys: ['[DLC][角色][维奥莱塔]'],
          origin: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德',
          build: {
            gender: '女', age: 20, race: '人类', identity: '非贵族平民',
            location: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德', level: 1,
            basePoints: { 力量: 5, 敏捷: 5, 体质: 5, 智力: 5, 精神: 5 },
            attributePoints: { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 },
            reincarnationPoints: 1_000, destinyPoints: 0, money: 0,
            equipments: [], items: [], skills: [], partners: [], customSelections: [], customPartners: [],
            background: '日常', backgroundDescription: '',
          },
        },
      },
  });

    expect(created.statusCode).toBe(201);
    const createdId = created.json().id as string;
    expect(repositories.conversationSceneStates.getByConversationId(createdId)?.value).toMatchObject({
      世界: { 地点: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德', 天气: '' },
      主角: { 姓名: '伊蕾娜', 性别: '女', 年龄: 20, 属性: { 力量: 5, 敏捷: 5, 体质: 5, 智力: 5, 精神: 5 } },
    });
    const ownership = repositories.saveWorldbooks.getByConversationId(createdId)!;
    expect(ownership.sourceWorldbookId).toBe(repositories.characters.get(installed.backingCharacterId)?.worldbookId);
    const saveEntries = repositories.worldbookEntries.listByWorldbookId(ownership.worldbookId);
    const enabled = new Map(saveEntries.map((entry) => [entry.comment, entry.enabled]));
    expect(enabled.get('命定系统-null核心(H一串)')).toBe(true);
    expect(enabled.get('命定系统-薇洛核心(银莳萝)')).toBe(false);
    expect(enabled.get('[DLC][角色][维奥莱塔]维奥莱塔(奥古斯提姆女皇-编者注:无敌了，怎么有人写自传啊 | 编者S注:已删了日轻警告，并非日轻💢)')).toBe(true);
    const sourceNullCore = repositories.worldbookEntries
      .listByWorldbookId(ownership.sourceWorldbookId!)
      .find((entry) => entry.comment === '命定系统-null核心(H一串)');
    expect(sourceNullCore?.enabled).toBe(false);

    const nullCore = saveEntries.find((entry) => entry.comment === '命定系统-null核心(H一串)')!;
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${createdId}/save-worldbook/${ownership.worldbookId}/entries/${nullCore.id}`,
      payload: { revision: nullCore.revision, patch: { content: 'Only this Save remembers the altered rule.' } },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      content: 'Only this Save remembers the altered rule.',
      comment: '命定系统-null核心(H一串)',
      sourceUid: nullCore.sourceUid,
    });
    expect(repositories.worldbookEntries.get(sourceNullCore!.id)?.content)
      .not.toBe('Only this Save remembers the altered rule.');

    expect(repositories.installedScenes.update(installed.id, installed.revision, {
      version: '2.11.0',
      archiveDigest: 'e'.repeat(64),
      manifest: { ...installed.manifest, version: '2.11.0' },
    }).ok).toBe(true);
    expect(upgradeInstalledOfficialScenes(database, directory, repositories)).toEqual([]);
    const upgraded = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    expect(upgraded.version).toBe('2.17.0');
    expect(upgraded.backingPresetId).toBe(originalPresetId);
    expect(repositories.presets.get(upgraded.backingPresetId!)?.name).toBe('命定之诗 Kemini5 3.8 专属预设');
    expect(repositories.presets.get(originalPresetId)).toBeDefined();
    expect(repositories.saveWorldbooks.getByConversationId(createdId)).toEqual(ownership);
    expect(repositories.worldbookEntries.get(nullCore.id)?.content).toBe('Only this Save remembers the altered rule.');
  }, 30_000);


  it('installs, upgrades, and uninstalls an isolated Scene Lab Save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-registry-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();

    const installed = await app.inject({ method: 'POST', url: `/api/scenes/${SCENE_LAB_SCENE_ID}/install` });
    expect(installed.statusCode).toBe(201);
    const scene = repositories.installedScenes.get(SCENE_LAB_SCENE_ID)!;
    expect(repositories.characters.get(scene.backingCharacterId)?.name).toBe('场景实验室引导员');
    expect(repositories.presets.get(scene.backingPresetId!)?.name).toBe('场景实验室最小生成配置');

    const created = await app.inject({
      method: 'POST',
      url: `/api/scenes/${SCENE_LAB_SCENE_ID}/conversations`,
      payload: {
        title: '信号观测',
        playerProfile: { name: '观察者', description: '' },
        setup: { experimentName: '信号观测' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(repositories.conversationSceneStates.getByConversationId(created.json().id)?.value).toEqual({
      experimentName: '信号观测', phase: 'ready', signal: 0,
    });
    const saveWorldbook = repositories.saveWorldbooks.getByConversationId(created.json().id)!;
    expect(repositories.worldbooks.get(saveWorldbook.worldbookId)).toBeDefined();

    const downgraded = repositories.installedScenes.update(scene.id, scene.revision, {
      version: '0.9.0',
      archiveDigest: 'c'.repeat(64),
      manifest: { ...scene.manifest, version: '0.9.0' },
    });
    expect(downgraded.ok).toBe(true);
    expect(upgradeInstalledOfficialScenes(database, directory, repositories)).toEqual([]);
    const upgraded = repositories.installedScenes.get(SCENE_LAB_SCENE_ID)!;
    expect(upgraded.version).toBe('1.0.1');
    expect(repositories.conversationSceneStates.getByConversationId(created.json().id)?.value).toEqual({
      experimentName: '信号观测', phase: 'ready', signal: 0,
    });

    const uninstalled = await app.inject({
      method: 'DELETE', url: `/api/scenes/${SCENE_LAB_SCENE_ID}`,
      payload: { revision: upgraded.revision, cascade: true },
    });
    expect(uninstalled.statusCode).toBe(200);
    expect(repositories.installedScenes.get(SCENE_LAB_SCENE_ID)).toBeUndefined();
    expect(repositories.conversations.get(created.json().id)).toBeUndefined();
    expect(repositories.saveWorldbooks.get(saveWorldbook.id)).toBeUndefined();
    expect(repositories.worldbooks.get(saveWorldbook.worldbookId)).toBeUndefined();
  }, 30_000);

  it('continues upgrading other official Scenes after one installed record fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-upgrade-isolation-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();
    for (const sceneId of [DESTINED_POEM_SCENE_ID, SCENE_LAB_SCENE_ID]) {
      expect((await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/install` })).statusCode).toBe(201);
    }
    const lab = repositories.installedScenes.get(SCENE_LAB_SCENE_ID)!;
    expect(repositories.installedScenes.update(lab.id, lab.revision, {
      version: '0.9.0', archiveDigest: 'd'.repeat(64), manifest: { ...lab.manifest, version: '0.9.0' },
    }).ok).toBe(true);
    database.sqlite.prepare('UPDATE installed_scenes SET payload = ? WHERE id = ?')
      .run('{', DESTINED_POEM_SCENE_ID);

    expect(upgradeInstalledOfficialScenes(database, directory, repositories)).toEqual([{
      sceneId: DESTINED_POEM_SCENE_ID, code: 'official_scene_install_record_invalid',
    }]);
    expect(repositories.installedScenes.get(SCENE_LAB_SCENE_ID)?.version).toBe('1.0.1');
  }, 30_000);
});
