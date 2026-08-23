import { rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type TavernDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import {
  createImportService,
  INSPECTION_TOKEN_TTL_MS,
  type ImportHandler,
  type StagedImportPreview,
} from '../src/services/import-service.js';
import { DEFAULT_INSPECTION_LIMITS } from '@tavernnext/st-compat';
import { TEST_REPOSITORY_OPTIONS } from './test-integrity-key.js';

const encoder = new TextEncoder();
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const characterId = '018f0000-0000-7000-8000-000000000701';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const serverConfig = (directory: string) => ({
  host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite'),
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-import-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  return { directory, database, repositories: createRepositories(database, TEST_REPOSITORY_OPTIONS) };
}

function multipart(fileName: string, bytes: Uint8Array, mediaType = 'application/json') {
  const boundary = '----tavernnext-import-test-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, bytes, tail]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function multipartParts(fileName: string, bytes: Uint8Array, mediaType = 'application/json') {
  const boundary = '----tavernnext-import-stream-boundary';
  return {
    bytes,
    head: encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
    tail: encoder.encode(`\r\n--${boundary}--\r\n`),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

class HeldMultipartUpload extends Readable {
  reads = 0;
  private headSent = false;
  private released = false;

  constructor(private readonly parts: ReturnType<typeof multipartParts>) {
    super();
  }

  override _read(): void {
    this.reads += 1;
    if (!this.headSent) {
      this.headSent = true;
      this.push(this.parts.head);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.push(this.parts.bytes);
    this.push(this.parts.tail);
    this.push(null);
  }
}

class SpyMultipartUpload extends Readable {
  reads = 0;
  private sent = false;

  constructor(private readonly parts: ReturnType<typeof multipartParts>) {
    super();
  }

  override _read(): void {
    this.reads += 1;
    if (this.sent) return;
    this.sent = true;
    this.push(this.parts.head);
    this.push(this.parts.bytes);
    this.push(this.parts.tail);
    this.push(null);
  }
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

  it('keeps durable rows and final assets when post-commit stage cleanup needs a bounded retry', async () => {
    const { directory, database, repositories } = await fixture();
    let removalAttempts = 0;
    const app = createApp({
      database,
      config: serverConfig(directory),
      importHandlers: [characterHandler],
      importCleanupIntervalMs: 5,
      importRemoveStage(path) {
        removalAttempts += 1;
        if (removalAttempts === 1) throw new Error('injected post-commit cleanup failure');
        rmSync(path, { recursive: true, force: true });
      },
    });
    apps.push(app);
    await app.ready();
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('cleanup.json', encoder.encode('{"spec":"chara_card_v3","data":{"name":"Cleanup"}}')),
    });
    const [stageName] = await readdir(join(directory, 'tmp', 'imports'));

    const committed = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });

    expect(committed.statusCode).toBe(201);
    expect(repositories.characters.list()).toHaveLength(1);
    const artifact = repositories.importArtifacts.list()[0];
    await expect(readFile(join(directory, 'assets', 'imports', artifact.id, 'avatar', 'source.bin'))).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(removalAttempts).toBeGreaterThanOrEqual(1);
    await vi.waitFor(async () => {
      await expect(access(join(directory, 'tmp', 'imports', stageName))).rejects.toThrow();
    }, { timeout: 500, interval: 10 });
    expect(repositories.characters.list()).toHaveLength(1);
    expect(repositories.importArtifacts.list()).toHaveLength(1);
    await expect(readFile(join(directory, 'assets', 'imports', artifact.id, 'avatar', 'source.bin'))).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects staged-original tampering before invoking a codec or opening a transaction', async () => {
    const { directory, database, repositories } = await fixture();
    const transactionClock = countDurableTransactions(database);
    let commitInvoked = false;
    const handler: ImportHandler = {
      ...characterHandler,
      id: 'task-7-tamper-proof',
      commit(context) {
        commitInvoked = true;
        return characterHandler.commit(context);
      },
    };
    const app = createApp({ database, config: serverConfig(directory), importHandlers: [handler] });
    apps.push(app);
    await app.ready();
    const source = encoder.encode('{"spec":"chara_card_v3","data":{"name":"Untampered"}}');
    const inspected = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('tamper.json', source) });
    const [stageName] = await readdir(join(directory, 'tmp', 'imports'));
    const tampered = source.slice();
    tampered[tampered.length - 3] ^= 1;
    await writeFile(join(directory, 'tmp', 'imports', stageName, 'original.bin'), tampered);
    const beforeTransactions = transactionClock.count();

    const committed = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });

    expect(committed.statusCode).toBe(500);
    expect(commitInvoked).toBe(false);
    expect(transactionClock.count()).toBe(beforeTransactions);
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(await readdir(join(directory, 'assets', 'imports'))).toEqual([]);
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
  });

  it('deep-clones and freezes nested preview state at inspection and codec boundaries', async () => {
    const { directory, database, repositories } = await fixture();
    const handlerPreview = { nested: { name: 'Original' } };
    let handlerMutationBlocked = false;
    const handler: ImportHandler = {
      id: 'task-7-deep-preview-proof',
      matches: () => true,
      async inspect() {
        return { normalizedPreview: handlerPreview, warnings: [], blockingErrors: [] };
      },
      commit(context) {
        try {
          (context.preview.normalizedPreview as { nested: { name: string } }).nested.name = 'Handler mutation';
        } catch {
          handlerMutationBlocked = true;
        }
        return {};
      },
    };
    const imports = createImportService({ dataDir: directory, database, repositories, handlers: [handler] });
    try {
      const inspected = await imports.inspect({
        fileName: 'preview.json', bytes: encoder.encode('{"spec":"chara_card_v3","data":{"name":"Original"}}'),
      }) as StagedImportPreview;
      handlerPreview.nested.name = 'Inspection alias mutation';
      try {
        (inspected.normalizedPreview as { nested: { name: string } }).nested.name = 'Caller mutation';
      } catch {
        // A deeply frozen return value intentionally rejects the attempted mutation.
      }

      imports.commit(inspected.inspectionToken);

      expect(handlerMutationBlocked).toBe(true);
      expect(repositories.importArtifacts.list()[0]?.compatibility?.rawPayload).toMatchObject({
        normalizedPreview: { nested: { name: 'Original' } },
      });
    } finally {
      imports.close();
      database.close();
    }
  });

  it('returns 429 when live-stage, staged-byte, or concurrent-inspection quotas are exhausted', async () => {
    const source = encoder.encode('{"spec":"chara_card_v3","data":{"name":"Quota"}}');
    const stageFixture = await fixture();
    const stageApp = createApp({
      database: stageFixture.database,
      config: serverConfig(stageFixture.directory),
      importHandlers: [characterHandler],
      importLimits: { maxLiveStages: 1, maxStagedBytes: source.byteLength * 8, maxConcurrentInspections: 2 },
    });
    apps.push(stageApp);
    await stageApp.ready();
    const first = await stageApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('one.json', source) });
    expect(first.statusCode).toBe(200);
    const stageLimited = await stageApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('two.json', source) });
    expect(stageLimited.statusCode).toBe(429);
    expect(stageLimited.json()).toMatchObject({ error: 'import_live_stage_limit' });

    const byteFixture = await fixture();
    const byteApp = createApp({
      database: byteFixture.database,
      config: serverConfig(byteFixture.directory),
      importHandlers: [characterHandler],
      importLimits: { maxLiveStages: 8, maxStagedBytes: source.byteLength, maxConcurrentInspections: 2 },
    });
    apps.push(byteApp);
    await byteApp.ready();
    expect((await byteApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('one.json', source) })).statusCode).toBe(200);
    const byteLimited = await byteApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('two.json', source) });
    expect(byteLimited.statusCode).toBe(429);
    expect(byteLimited.json()).toMatchObject({ error: 'import_staged_bytes_limit' });

    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    let entered = 0;
    const concurrentHandler: ImportHandler = {
      ...characterHandler,
      id: 'task-7-concurrency-proof',
      async inspect() {
        entered += 1;
        if (entered <= 2) await inspectionGate;
        return { normalizedPreview: {}, warnings: [], blockingErrors: [] };
      },
    };
    const concurrentFixture = await fixture();
    const concurrentApp = createApp({
      database: concurrentFixture.database,
      config: serverConfig(concurrentFixture.directory),
      importHandlers: [concurrentHandler],
      importLimits: { maxLiveStages: 8, maxStagedBytes: source.byteLength * 8, maxConcurrentInspections: 2 },
    });
    apps.push(concurrentApp);
    await concurrentApp.ready();
    const pendingOne = concurrentApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('one.json', source) });
    const pendingTwo = concurrentApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('two.json', source) });
    await vi.waitFor(() => expect(entered).toBe(2));
    const concurrentLimited = await concurrentApp.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('three.json', source) });
    expect(concurrentLimited.statusCode).toBe(429);
    expect(concurrentLimited.json()).toMatchObject({ error: 'import_inspection_concurrency_limit' });
    releaseInspection();
    await expect(Promise.all([pendingOne, pendingTwo])).resolves.toEqual([
      expect.objectContaining({ statusCode: 200 }), expect.objectContaining({ statusCode: 200 }),
    ]);
  });

  it('leases inspection capacity before multipart reads and never consumes a rejected third upload', async () => {
    const { directory, database } = await fixture();
    const source = encoder.encode('{"spec":"chara_card_v3","data":{"name":"Streamed"}}');
    const app = createApp({
      database,
      config: serverConfig(directory),
      importHandlers: [characterHandler],
      importLimits: { maxLiveStages: 8, maxStagedBytes: source.byteLength * 8, maxConcurrentInspections: 2 },
    });
    apps.push(app);
    await app.ready();

    const firstParts = multipartParts('first.json', source);
    const secondParts = multipartParts('second.json', source);
    const firstUpload = new HeldMultipartUpload(firstParts);
    const secondUpload = new HeldMultipartUpload(secondParts);
    const firstResponse = app.inject({ method: 'POST', url: '/api/imports/inspect', payload: firstUpload, headers: firstParts.headers });
    const secondResponse = app.inject({ method: 'POST', url: '/api/imports/inspect', payload: secondUpload, headers: secondParts.headers });
    await vi.waitFor(() => {
      expect(firstUpload.reads).toBeGreaterThan(0);
      expect(secondUpload.reads).toBeGreaterThan(0);
    });

    const thirdParts = multipartParts('third.json', source);
    const thirdUpload = new SpyMultipartUpload(thirdParts);
    try {
      const rejected = await app.inject({ method: 'POST', url: '/api/imports/inspect', payload: thirdUpload, headers: thirdParts.headers });
      expect(rejected.statusCode).toBe(429);
      expect(rejected.json()).toMatchObject({ error: 'import_inspection_concurrency_limit' });
      expect(thirdUpload.reads).toBe(0);
    } finally {
      firstUpload.release();
      secondUpload.release();
      thirdUpload.destroy();
    }
    await expect(Promise.all([firstResponse, secondResponse])).resolves.toEqual([
      expect.objectContaining({ statusCode: 200 }), expect.objectContaining({ statusCode: 200 }),
    ]);
  });

  it('expires stages on the scheduled timer without requiring another request', async () => {
    const { directory, database } = await fixture();
    let now = Date.parse('2026-08-08T00:00:00.000Z');
    const app = createApp({
      database,
      config: serverConfig(directory),
      importHandlers: [characterHandler],
      importClock: () => now,
      importCleanupIntervalMs: 5,
    });
    apps.push(app);
    await app.ready();
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('expires.json', encoder.encode('{"spec":"chara_card_v3","data":{"name":"Expires"}}')),
    });
    expect((await readdir(join(directory, 'tmp', 'imports'))).length).toBe(1);

    now += INSPECTION_TOKEN_TTL_MS;
    await vi.waitFor(async () => {
      await expect(readdir(join(directory, 'tmp', 'imports'))).resolves.toEqual([]);
    }, { timeout: 500, interval: 10 });
    const expired = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });
    expect(expired.statusCode).toBe(410);
  });

  it('recovers only stale UUID-owned stage directories on startup', async () => {
    const { directory, database } = await fixture();
    const stagingRoot = join(directory, 'tmp', 'imports');
    await mkdir(stagingRoot, { recursive: true });
    const staleUuid = '018f0000-0000-7000-8000-000000000711';
    const freshUuid = '018f0000-0000-7000-8000-000000000712';
    const unrelated = 'unrelated-owner-directory';
    await Promise.all([staleUuid, freshUuid, unrelated].map((name) => mkdir(join(stagingRoot, name))));
    const now = Date.parse('2026-08-08T12:00:00.000Z');
    const staleTime = new Date(now - INSPECTION_TOKEN_TTL_MS - 1);
    await utimes(join(stagingRoot, staleUuid), staleTime, staleTime);

    const app = createApp({ database, config: serverConfig(directory), importClock: () => now });
    apps.push(app);
    await app.ready();

    await expect(access(join(stagingRoot, staleUuid))).rejects.toThrow();
    await expect(access(join(stagingRoot, freshUuid))).resolves.toBeUndefined();
    await expect(access(join(stagingRoot, unrelated))).resolves.toBeUndefined();
  });

  it('recovers stale managed inspection workspaces while preserving fresh and unrelated directories', async () => {
    const { directory, database } = await fixture();
    const workspaceRoot = join(directory, 'tmp', 'inspection-workspaces');
    await mkdir(workspaceRoot, { recursive: true });
    const staleUuid = '018f0000-0000-7000-8000-000000000721';
    const freshUuid = '018f0000-0000-7000-8000-000000000722';
    const unrelated = 'another-tools-workspace';
    await Promise.all([staleUuid, freshUuid, unrelated].map((name) => mkdir(join(workspaceRoot, name))));
    let now = Date.parse('2026-08-08T12:00:00.000Z');
    const staleTime = new Date(now - INSPECTION_TOKEN_TTL_MS - 1);
    await utimes(join(workspaceRoot, staleUuid), staleTime, staleTime);
    await utimes(join(workspaceRoot, freshUuid), new Date(now), new Date(now));

    const app = createApp({
      database,
      config: serverConfig(directory),
      importClock: () => now,
      importCleanupIntervalMs: 5,
    });
    apps.push(app);
    await app.ready();

    await expect(access(join(workspaceRoot, staleUuid))).rejects.toThrow();
    await expect(access(join(workspaceRoot, freshUuid))).resolves.toBeUndefined();
    await expect(access(join(workspaceRoot, unrelated))).resolves.toBeUndefined();
    now += INSPECTION_TOKEN_TTL_MS;
    await vi.waitFor(async () => {
      await expect(access(join(workspaceRoot, freshUuid))).rejects.toThrow();
    }, { timeout: 500, interval: 10 });
    await expect(access(join(workspaceRoot, unrelated))).resolves.toBeUndefined();
  });
});
