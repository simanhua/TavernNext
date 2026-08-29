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

    const downgraded = repositories.installedScenes.update(scene.id, scene.revision, {
      version: '0.9.0',
      archiveDigest: 'c'.repeat(64),
      manifest: { ...scene.manifest, version: '0.9.0' },
    });
    expect(downgraded.ok).toBe(true);
    expect(upgradeInstalledOfficialScenes(database, directory)).toEqual([]);
    const upgraded = repositories.installedScenes.get(SCENE_LAB_SCENE_ID)!;
    expect(upgraded.version).toBe('1.0.0');
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

    expect(upgradeInstalledOfficialScenes(database, directory)).toEqual([{
      sceneId: DESTINED_POEM_SCENE_ID, code: 'official_scene_install_record_invalid',
    }]);
    expect(repositories.installedScenes.get(SCENE_LAB_SCENE_ID)?.version).toBe('1.0.0');
  }, 30_000);
});
