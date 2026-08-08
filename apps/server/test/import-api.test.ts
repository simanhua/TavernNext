import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type TavernDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import type { ImportHandler } from '../src/services/import-service.js';
import { DEFAULT_INSPECTION_LIMITS } from '@tavernnext/st-compat';

const encoder = new TextEncoder();
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const characterId = '018f0000-0000-7000-8000-000000000701';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-import-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  return { directory, database, repositories: createRepositories(database) };
}

function multipart(fileName: string, bytes: Uint8Array, mediaType = 'application/json') {
  const boundary = '----tavernnext-import-test-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, bytes, tail]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const characterHandler: ImportHandler = {
  id: 'task-7-character-proof',
  matches: (preview) => preview.detected.kind === 'character',
  inspect: async () => ({
    normalizedPreview: { name: 'Aster', description: 'A careful archivist.' },
    warnings: [],
    blockingErrors: [],
  }),
  commit(context) {
    const character = context.repositories.characters.create({
      id: characterId,
      name: 'Aster', description: 'A careful archivist.', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [], avatarPath: context.writeAsset('avatar/source.bin', Uint8Array.from([1, 2, 3])),
    });
    return { entityId: character.id };
  },
};

function countDurableTransactions(database: TavernDatabase): { count: () => number } {
  const original = database.transaction.bind(database);
  let depth = 0;
  let topLevel = 0;
  database.transaction = (work) => {
    if (depth === 0) topLevel += 1;
    depth += 1;
    try {
      return original(work);
    } finally {
      depth -= 1;
    }
  };
  return { count: () => topLevel };
}

describe('two-stage import API', () => {
  it('inspects without entity mutations, stages opaquely, then commits rows and assets in one durable transaction', async () => {
    const { directory, database, repositories } = await fixture();
    const clock = countDurableTransactions(database);
    const app = createApp({
      database,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      importHandlers: [characterHandler],
    });
    apps.push(app);
    await app.ready();
    const source = encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Aster"}}');

    const beforeTransactions = clock.count();
    const inspected = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('aster.json', source) });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({
      detected: { container: 'json', kind: 'character', version: '3.0' },
      normalizedPreview: { name: 'Aster' },
      blockingErrors: [],
    });
    const token = inspected.json().inspectionToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.personas.list()).toEqual([]);
    expect(repositories.presets.list()).toEqual([]);
    expect(repositories.worldbooks.list()).toEqual([]);
    expect(repositories.worldbookEntries.list()).toEqual([]);
    expect(repositories.conversations.list()).toEqual([]);
    expect(repositories.messages.list()).toEqual([]);
    expect(repositories.messageVariants.list()).toEqual([]);
    expect(repositories.providerProfiles.list()).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(clock.count()).toBe(beforeTransactions);
    expect((await readdir(join(directory, 'tmp', 'imports'))).length).toBe(1);

    const committed = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: token } });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({ entityId: characterId });
    expect(clock.count()).toBe(beforeTransactions + 1);
    expect(repositories.characters.get(characterId)).toMatchObject({ name: 'Aster' });
    const artifact = repositories.importArtifacts.list()[0];
    expect(artifact).toMatchObject({ entityId: characterId, sourceName: 'aster.json', mediaType: 'application/json' });
    expect(Buffer.from(artifact.rawArtifact, 'base64')).toEqual(Buffer.from(source));
    expect(artifact.compatibility?.rawPayload).toMatchObject({
      sha256: '9b9e71f4f407a2eccb9c54095fa4d261452e26ffd875f2f2f9c406f9d9ff9fc8',
    });
    expect(await readFile(join(directory, 'assets', 'imports', artifact.id, 'avatar', 'source.bin'))).toEqual(Buffer.from([1, 2, 3]));
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);

    const replayed = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: token } });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toMatchObject({ error: 'inspection_token_consumed' });
    expect(repositories.characters.list()).toHaveLength(1);
    expect(repositories.importArtifacts.list()).toHaveLength(1);
  });

  it('rejects invalid and 15-minute-expired tokens and removes only their task-scoped stages', async () => {
    const { directory, database } = await fixture();
    let now = Date.parse('2026-08-08T00:00:00.000Z');
    const app = createApp({
      database,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      importHandlers: [characterHandler], importClock: () => now,
    });
    apps.push(app);
    await app.ready();
    const invalid = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: 'not-a-real-token' } });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json()).toMatchObject({ error: 'inspection_token_invalid' });

    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('aster.json', encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Aster"}}')),
    });
    const token = inspected.json().inspectionToken as string;
    const [stageName] = await readdir(join(directory, 'tmp', 'imports'));
    const unrelated = join(directory, 'tmp', 'imports', 'unrelated-owner-directory');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(unrelated));
    now += 15 * 60 * 1000;
    const renewed = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('renewed.json', encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Renewed"}}')),
    });
    expect(renewed.statusCode).toBe(200);

    const expired = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: token } });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: 'inspection_token_expired' });
    await expect(access(join(directory, 'tmp', 'imports', stageName))).rejects.toThrow();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it('rolls back both rows when the final atomic asset move fails', async () => {
    const { directory, database, repositories } = await fixture();
    const app = createApp({
      database,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      importHandlers: [characterHandler],
      importMoveAssets: () => { throw new Error('injected rename failure'); },
    });
    apps.push(app);
    await app.ready();
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('aster.json', encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Aster"}}')),
    });
    const token = inspected.json().inspectionToken;
    const failed = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: token } });
    expect(failed.statusCode).toBe(500);
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
    expect(await readdir(join(directory, 'assets', 'imports'))).toEqual([]);
  });

  it('keeps staged original bytes immutable across codec inspection and commit', async () => {
    const { directory, database, repositories } = await fixture();
    const mutatingHandler: ImportHandler = {
      id: 'task-7-mutation-proof',
      matches: (preview) => preview.detected.kind === 'character',
      async inspect(context) {
        context.artifact.bytes.fill(0);
        return { normalizedPreview: {}, warnings: [], blockingErrors: [] };
      },
      commit(context) {
        context.artifact.bytes.fill(1);
        return {};
      },
    };
    const app = createApp({
      database,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      importHandlers: [mutatingHandler],
    });
    apps.push(app);
    await app.ready();
    const source = encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Immutable"}}');
    const inspected = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('immutable.json', source) });
    const committed = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken } });
    expect(committed.statusCode).toBe(201);
    const artifact = repositories.importArtifacts.list()[0];
    expect(Buffer.from(artifact.rawArtifact, 'base64')).toEqual(Buffer.from(source));
    expect(artifact.compatibility?.rawPayload).toMatchObject({ sha256: inspected.json().source.sha256 });
  });

  it('rolls back normalized and artifact rows and fully cleans task assets when commit fails', async () => {
    const { directory, database, repositories } = await fixture();
    const failingHandler: ImportHandler = {
      ...characterHandler,
      id: 'task-7-failure-proof',
      commit(context) {
        context.repositories.characters.create({
          id: characterId, name: 'Rolled back', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
        });
        context.writeAsset('partial.bin', Uint8Array.from([9, 8, 7]));
        throw new Error('injected commit failure');
      },
    };
    const app = createApp({
      database,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      importHandlers: [failingHandler],
    });
    apps.push(app);
    await app.ready();
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('aster.json', encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Aster"}}')),
    });
    const token = inspected.json().inspectionToken;
    const failed = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: token } });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: 'import_commit_failed' });
    expect(failed.payload).not.toContain('injected commit failure');
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
    await expect(readdir(join(directory, 'assets', 'imports'))).resolves.toEqual([]);
    const replayed = await app.inject({ method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: token } });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toMatchObject({ error: 'inspection_token_consumed' });
  });

  it('rejects malformed and oversized multipart uploads before issuing a token', async () => {
    const { directory, database } = await fixture();
    const app = createApp({
      database,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
    });
    apps.push(app);
    await app.ready();
    const missing = await app.inject({ method: 'POST', url: '/api/imports/inspect', payload: {} });
    expect(missing.statusCode).toBe(415);

    const invalid = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('broken.json', encoder.encode('{"name":')) });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ blockingErrors: [expect.objectContaining({ code: 'invalid_json' })] });
    expect(invalid.json()).not.toHaveProperty('inspectionToken');
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);

    const oversized = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('oversized.json', new Uint8Array(DEFAULT_INSPECTION_LIMITS.maxUploadBytes + 1)),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: 'upload_too_large' });
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
  });
});
