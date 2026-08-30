import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import {
  isOfficialPresetId,
  officialPresetDefinitions,
  officialPresetIdForBytes,
  synchronizeOfficialPresets,
} from '../src/services/official-preset-registry.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];

function databaseContext() {
  const directory = mkdtempSync(join(tmpdir(), 'tavernnext-official-presets-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  return { directory, database, repositories: createRepositories(database, TEST_REPOSITORY_OPTIONS) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Official Preset catalog', () => {
  it('materializes every content-distinct local Preset and restores code-owned data without duplicate writes', () => {
    const { database, repositories } = databaseContext();
    const definitions = officialPresetDefinitions();
    expect(definitions).toHaveLength(8);

    synchronizeOfficialPresets(repositories);
    const official = definitions.map(({ entry }) => repositories.presets.get(entry.id)!);
    expect(official.map((preset) => preset.name)).toEqual(expect.arrayContaining([
      '命定之诗内置生成配方',
      '场景实验室最小生成配置',
      '命定之诗 Kemini5 3.8 专属预设',
      '太虚问道 Scene 生成配置',
      '仓鼠之神V4.8.2',
      '夏瑾 天琴座 Beta 3.6',
    ]));
    expect(official.every((preset) => isOfficialPresetId(preset.id))).toBe(true);
    expect(repositories.presets.get('44800b9a-ac22-447d-a6a5-89d31fe1c5e5')?.settings.prompts)
      .toHaveLength(68);
    expect(repositories.extensionAssets.listByOwner('preset', '71ad75b3-aa78-4c6b-a8f6-179c08114000').length)
      .toBeGreaterThan(0);

    const first = official[0]!;
    const drifted = repositories.presets.update(first.id, first.revision, { name: 'Local drift' });
    expect(drifted.ok).toBe(true);
    synchronizeOfficialPresets(repositories);
    const restored = repositories.presets.get(first.id)!;
    expect(restored.name).toBe(definitions[0]!.entry.name);
    const revisions = definitions.map(({ entry }) => repositories.presets.get(entry.id)!.revision);
    synchronizeOfficialPresets(repositories);
    expect(definitions.map(({ entry }) => repositories.presets.get(entry.id)!.revision)).toEqual(revisions);
    database.close();
  });

  it('reuses official templates for Scene backing Presets and exposes them as read-only API records', async () => {
    const { directory, database } = databaseContext();
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      synchronizeOfficialPresetCatalog: true,
      memoryWorkerIntervalMs: false,
      config: {
        host: '127.0.0.1', port: 0, dataDir: directory, databasePath: database.path,
      },
    });
    await app.ready();

    for (const path of [
      'apps/server/assets/official-scenes/destined-poem/content/preset.json',
      'apps/server/assets/official-scenes/scene-lab/content/preset.json',
      'apps/server/assets/official-scenes/taixu-chronicles/content/preset.json',
    ]) {
      const id = officialPresetIdForBytes(new Uint8Array(readFileSync(resolve(path))), path);
      expect(id).toSatisfy((value: unknown) => typeof value === 'string' && isOfficialPresetId(value));
    }

    const listed = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().filter((preset: { official: boolean }) => preset.official)).toHaveLength(8);
    const id = officialPresetDefinitions()[0]!.entry.id;
    const patched = await app.inject({
      method: 'PATCH', url: `/api/presets/${id}`,
      payload: { revision: 0, patch: { name: 'Changed official Preset' } },
    });
    expect(patched.statusCode).toBe(409);
    expect(patched.json()).toEqual({ error: 'official_preset_read_only' });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/presets/${id}?revision=0` });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual({ error: 'official_preset_read_only' });
    await app.close();
  });
});
