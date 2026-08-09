import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const encoder = new TextEncoder();
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function multipart(fileName: string, bytes: Uint8Array) {
  const boundary = '----tavernnext-task-16-import-recovery';
  return {
    payload: Buffer.concat([
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/json\r\n\r\n`),
      bytes,
      encoder.encode(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('import recovery', () => {
  it('removes rows, database-owned avatars, a partially moved final asset, and staging after a move reports failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-import-recovery-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: {
        host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'tavernnext.sqlite'),
      },
      importMoveAssets(source, destination) {
        renameSync(source, destination);
        throw new Error('injected failure after destination publication');
      },
    });
    apps.push(app);
    await app.ready();

    const inspected = await app.inject({
      method: 'POST',
      url: '/api/imports/inspect',
      ...multipart(
        'recovery.json',
        encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Recovery"}}'),
      ),
    });
    expect(inspected.statusCode).toBe(200);
    const failed = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: { inspectionToken: inspected.json().inspectionToken },
    });

    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
    expect(await readdir(join(directory, 'assets', 'imports'))).toEqual([]);
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
  });

  it('does not delete a different pre-existing destination when an atomic move refuses a collision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-import-collision-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    let collisionSentinel = '';
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: {
        host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'tavernnext.sqlite'),
      },
      importMoveAssets(_source, destination) {
        mkdirSync(destination);
        collisionSentinel = join(destination, 'pre-existing-owner.bin');
        writeFileSync(collisionSentinel, 'unrelated');
        throw new Error('injected destination collision');
      },
    });
    apps.push(app);
    await app.ready();

    const inspected = await app.inject({
      method: 'POST',
      url: '/api/imports/inspect',
      ...multipart(
        'collision.json',
        encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Collision"}}'),
      ),
    });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: { inspectionToken: inspected.json().inspectionToken },
    });

    expect(failed.statusCode).toBe(500);
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(await readFile(collisionSentinel, 'utf8')).toBe('unrelated');
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
  });
});
