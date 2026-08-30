import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import {
  isOfficialPresetId,
  officialPresetDefinitions,
  officialPresetIdForBytes,
} from '../src/services/official-preset-registry.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Official Preset API', () => {
  it('reuses official templates for Scene backing Presets and exposes them as read-only records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tavernnext-official-preset-api-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
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
