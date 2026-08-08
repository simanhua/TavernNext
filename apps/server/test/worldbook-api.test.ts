import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCharacter } from '@tavernnext/st-compat';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { registerCharacterExportRoutes } from '../src/routes/character-exports.js';
import { registerWorldbookExportRoutes } from '../src/routes/worldbook-exports.js';

interface PngChunk { name: string; data: Uint8Array }

const requireFromHere = createRequire(import.meta.url);
const { encode: encodePngText } = requireFromHere('png-chunk-text') as {
  encode(keyword: string, text: string): PngChunk;
};
const encodePngChunks = requireFromHere('png-chunks-encode') as (chunks: readonly PngChunk[]) => Uint8Array;
const extractPngChunks = requireFromHere('png-chunks-extract') as (data: Uint8Array) => PngChunk[];
const encoder = new TextEncoder();
const worldbookFixtures = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'worldbooks');
const characterFixtures = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'characters');
const missingId = '018f0000-0000-7000-8000-000000001101';
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context(options: Partial<NonNullable<Parameters<typeof createApp>[0]>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-worldbook-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database);
  const app = createApp({
    ...options,
    database,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, directory, repositories };
}

function multipart(fileName: string, bytes: Uint8Array, mediaType = 'application/json') {
  const boundary = '----tavernnext-worldbook-api-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function fixture(root: string, name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(root, name)));
}

async function inspectAndCommit(
  app: ReturnType<typeof createApp>,
  fileName = 'all-fields.json',
  mediaType = fileName.endsWith('.png') ? 'image/png' : 'application/json',
) {
  const inspected = await app.inject({
    method: 'POST',
    url: '/api/imports/inspect',
    ...multipart(fileName, await fixture(worldbookFixtures, fileName), mediaType),
  });
  expect(inspected.statusCode).toBe(200);
  expect(inspected.json()).toMatchObject({
    detected: { kind: 'worldbook' },
    normalizedPreview: {
      name: expect.any(String),
      entries: expect.any(Array),
    },
    blockingErrors: [],
  });
  const committed = await app.inject({
    method: 'POST',
    url: '/api/imports/commit',
    payload: { inspectionToken: inspected.json().inspectionToken },
  });
  return { inspected, committed };
}

async function importCharacter(app: ReturnType<typeof createApp>) {
  const bytes = await fixture(characterFixtures, 'v3.json');
  const inspected = await app.inject({
    method: 'POST', url: '/api/imports/inspect', ...multipart('character.v3.json', bytes),
  });
  expect(inspected.statusCode).toBe(200);
  const committed = await app.inject({
    method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
  });
  expect(committed.statusCode).toBe(201);
  return committed.json().entityId as string;
}

describe('typed Worldbook import and export API', () => {
  it('registers the Worldbook handler and atomically creates one book, every entry, and one ImportArtifact', async () => {
    const { app, repositories } = await context();
    const { inspected, committed } = await inspectAndCommit(app);

    expect(inspected.json().normalizedPreview).toMatchObject({
      name: 'All Fields 世界書',
      scanDepth: 12,
      tokenBudget: 2048,
      recursiveScanning: true,
      entries: [expect.objectContaining({ sourceUid: 7, group: 'synthetic-group', sticky: 3 })],
    });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({ entityId: expect.any(String), artifactId: expect.any(String) });

    const worldbook = repositories.worldbooks.get(committed.json().entityId as string);
    expect(worldbook).toMatchObject({
      name: 'All Fields 世界書', description: expect.stringContaining('runtime field'),
      scanDepth: 12, tokenBudget: 2048, recursiveScanning: true,
      compatibility: {
        sourceFormat: 'worldbook:st-native',
        rawPayload: expect.objectContaining({ sourceFormat: 'st-native', rawDocument: expect.any(Object) }),
      },
    });
    expect(repositories.worldbookEntries.list()).toEqual([
      expect.objectContaining({
        worldbookId: worldbook?.id,
        sourceUid: 7,
        keys: ['alpha', '/βeta/iu'],
        secondaryKeys: ['gamma', 'delta'],
        position: 4,
        role: 2,
        compatibility: expect.objectContaining({ sourceFormat: 'worldbook-entry:st-native' }),
      }),
    ]);
    expect(repositories.importArtifacts.list()).toEqual([
      expect.objectContaining({ entityId: worldbook?.id, sourceName: 'all-fields.json', kind: 'worldbook' }),
    ]);
  });

  it('recognizes and commits naidata PNG through the default typed handler', async () => {
    const { app, repositories } = await context();
    const { inspected, committed } = await inspectAndCommit(app, 'naidata.png');

    expect(inspected.json()).toMatchObject({ detected: { container: 'png', kind: 'worldbook' } });
    expect(committed.statusCode).toBe(201);
    expect(repositories.worldbooks.list()).toEqual([expect.objectContaining({ name: 'Native Synthetic Lore' })]);
    expect(repositories.worldbookEntries.list()).toHaveLength(2);
  });

  it('rolls back Worldbook, all entries, and ImportArtifact when the final asset move fails', async () => {
    const { app, repositories } = await context({
      importMoveAssets: () => { throw new Error('injected Worldbook move failure'); },
    });
    const { committed } = await inspectAndCommit(app);

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.worldbooks.list()).toEqual([]);
    expect(repositories.worldbookEntries.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('rejects persisted-domain violations during inspect and never reaches a mutating commit', async () => {
    const { app, repositories } = await context();
    const source = encoder.encode(JSON.stringify({
      name: 'Invalid persisted values',
      entries: {
        invalid: {
          uid: 'invalid', key: [], content: 'invalid', order: 1.5,
          characterFilter: { names: 'not-an-array' },
        },
      },
    }));

    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('invalid-domain.json', source),
    });
    expect(inspected.statusCode).toBe(422);
    expect(inspected.json()).toMatchObject({
      normalizedPreview: null,
      blockingErrors: expect.arrayContaining([
        expect.objectContaining({ code: 'worldbook_content_invalid', path: 'entries[0].order' }),
        expect.objectContaining({ code: 'worldbook_content_invalid', path: 'entries.invalid.characterFilter.names' }),
      ]),
    });
    expect(inspected.json().inspectionToken).toBeUndefined();

    const committed = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: 'blocked-worldbook-inspection-has-no-token' },
    });
    expect(committed.statusCode).toBe(404);
    expect(committed.json()).toEqual({ error: 'inspection_token_invalid' });
    expect(repositories.worldbooks.list()).toEqual([]);
    expect(repositories.worldbookEntries.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('preserves stable Worldbook codec limit codes through the server inspection boundary', async () => {
    const { app } = await context();
    const entries = Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [String(index), {
      uid: index, key: [], content: '',
    }]));
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('too-many-worldbook-entries.json', encoder.encode(JSON.stringify({ entries }))),
    });

    expect(inspected.statusCode).toBe(422);
    expect(inspected.json()).toMatchObject({
      blockingErrors: [expect.objectContaining({ code: 'worldbook_entry_limit' })],
    });
    expect(inspected.json().inspectionToken).toBeUndefined();
  });

  it('propagates the raw naidata metadata limit through server inspection', async () => {
    const { app } = await context();
    const source = await fixture(worldbookFixtures, 'naidata.png');
    const chunks = extractPngChunks(source).filter((chunk) => chunk.name !== 'tEXt');
    chunks.splice(-1, 0, encodePngText('naidata', ' '.repeat(2 * 1024 * 1024 + 1)));
    const inspected = await app.inject({
      method: 'POST',
      url: '/api/imports/inspect',
      ...multipart('oversized-naidata.png', encodePngChunks(chunks), 'image/png'),
    });

    expect(inspected.statusCode).toBe(422);
    expect(inspected.json()).toMatchObject({
      blockingErrors: [expect.objectContaining({ code: 'worldbook_preview_limit' })],
    });
    expect(inspected.json().inspectionToken).toBeUndefined();
  });

  it('exports deterministic native JSON with an exact content type and rejects invalid formats and IDs', async () => {
    const { app, repositories } = await context();
    const { committed } = await inspectAndCommit(app);
    expect(committed.statusCode).toBe(201);
    const id = committed.json().entityId as string;
    const entry = repositories.worldbookEntries.list()[0]!;
    expect(repositories.worldbookEntries.update(entry.id, 0, { content: 'Edited persisted Worldbook content.' })).toMatchObject({ ok: true });
    const indexedQuery = vi.spyOn(repositories.worldbookEntries, 'listByWorldbookId');
    const fullScan = vi.spyOn(repositories.worldbookEntries, 'list').mockImplementation(() => {
      throw new Error('full Worldbook entry scans are forbidden during export');
    });
    const exportApp = Fastify();
    registerWorldbookExportRoutes(exportApp, repositories);
    apps.push(exportApp);
    await exportApp.ready();

    const first = await exportApp.inject({ method: 'GET', url: `/api/worldbooks/${id}/export?format=st-native` });
    const second = await exportApp.inject({ method: 'GET', url: `/api/worldbooks/${id}/export?format=st-native` });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(first.headers['content-disposition']).toMatch(/^attachment; filename="All Fields _+\.json"; filename\*=UTF-8''/);
    expect(first.rawPayload).toEqual(second.rawPayload);
    expect(first.json()).toMatchObject({
      entries: { '7': { uid: 7, content: 'Edited persisted Worldbook content.', position: 4 } },
    });
    expect(fullScan).not.toHaveBeenCalled();
    expect(indexedQuery).toHaveBeenCalledWith(id);
    expect((await exportApp.inject({ method: 'GET', url: `/api/worldbooks/${id}/export?format=zip` })).statusCode).toBe(400);
    expect((await exportApp.inject({ method: 'GET', url: `/api/worldbooks/${missingId}/export?format=st-native` })).statusCode).toBe(404);
  });

  it('serves a path-hostile Unicode name over real HTTP without header injection', async () => {
    const { app, repositories } = await context();
    const { committed } = await inspectAndCommit(app);
    const id = committed.json().entityId as string;
    expect(repositories.worldbooks.update(id, 0, { name: '../雪書\\..\r\nX-Injected: yes' })).toMatchObject({ ok: true });

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/api/worldbooks/${id}/export?format=st-native`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const disposition = response.headers.get('content-disposition')!;
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toMatch(/[\r\n\\/]/);
    expect(disposition).not.toContain('..');
    expect(response.headers.get('x-injected')).toBeNull();
    expect((await response.json()).name).toBe('../雪書\\..\r\nX-Injected: yes');
  });

  it('re-embeds the currently linked Character Book with its compatibility envelope and current entry edits', async () => {
    const { app, repositories } = await context();
    const characterId = await importCharacter(app);
    const { committed } = await inspectAndCommit(app, 'character-book.json');
    expect(committed.statusCode).toBe(201);
    const worldbookId = committed.json().entityId as string;

    expect(repositories.characters.update(characterId, 0, { worldbookId })).toMatchObject({ ok: true });
    const linkedEntry = repositories.worldbookEntries.list().find((entry) => entry.worldbookId === worldbookId && entry.sourceUid === 42)!;
    expect(repositories.worldbookEntries.update(linkedEntry.id, 0, {
      content: 'Edited linked Character Book content.',
    })).toMatchObject({ ok: true });
    expect(repositories.worldbooks.update(worldbookId, 0, { name: 'Currently linked lore' })).toMatchObject({ ok: true });

    const exported = await app.inject({
      method: 'GET', url: `/api/characters/${characterId}/export?format=json-v3`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      top_unknown: { keep: 'v3-top' },
      data: {
        character_book: {
          name: 'Currently linked lore',
          character_book_unknown: { preserve: true },
          extensions: { book_unknown: 'keep-character-book', nested: { value: 1 } },
          entries: expect.arrayContaining([expect.objectContaining({
            id: 42,
            content: 'Edited linked Character Book content.',
            entry_extra: 'keep-character-book-entry',
            extensions: expect.objectContaining({ entry_unknown: { keep: 'character-book-extension' } }),
          })]),
        },
      },
    });
  });

  it('uses the indexed entry query while replacing a linked book in the original Character PNG', async () => {
    const { app, directory, repositories } = await context();
    const seedCharacterId = await importCharacter(app);
    const sourcePng = await app.inject({
      method: 'GET', url: `/api/characters/${seedCharacterId}/export?format=png`,
    });
    expect(sourcePng.statusCode).toBe(200);

    const inspectedPng = await app.inject({
      method: 'POST', url: '/api/imports/inspect',
      ...multipart('source-character.png', sourcePng.rawPayload, 'image/png'),
    });
    expect(inspectedPng.statusCode).toBe(200);
    const committedPng = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspectedPng.json().inspectionToken },
    });
    expect(committedPng.statusCode).toBe(201);
    const pngCharacterId = committedPng.json().entityId as string;

    const { committed } = await inspectAndCommit(app, 'character-book.json');
    const worldbookId = committed.json().entityId as string;
    expect(repositories.characters.update(pngCharacterId, 0, { worldbookId })).toMatchObject({ ok: true });
    const linkedEntry = repositories.worldbookEntries.list().find((entry) => entry.worldbookId === worldbookId && entry.sourceUid === 42)!;
    expect(repositories.worldbookEntries.update(linkedEntry.id, 0, {
      content: 'Current linked lore inside source PNG.',
    })).toMatchObject({ ok: true });

    const indexedRows = repositories.worldbookEntries.list().filter((entry) => entry.worldbookId === worldbookId);
    const indexedQuery = vi.fn((requestedId: string) => requestedId === worldbookId ? indexedRows : []);
    (repositories.worldbookEntries as unknown as { listByWorldbookId(id: string): typeof indexedRows }).listByWorldbookId = indexedQuery;
    const fullScan = vi.spyOn(repositories.worldbookEntries, 'list').mockImplementation(() => {
      throw new Error('full Worldbook entry scans are forbidden during export');
    });
    const exportApp = Fastify();
    apps.push(exportApp);
    registerCharacterExportRoutes(exportApp, repositories, directory);
    await exportApp.ready();

    const exported = await exportApp.inject({
      method: 'GET', url: `/api/characters/${pngCharacterId}/export?format=png`,
    });
    expect(exported.statusCode).toBe(200);
    expect(fullScan).not.toHaveBeenCalled();
    expect(indexedQuery).toHaveBeenCalledWith(worldbookId);
    const preview = await inspectCharacter(Uint8Array.from(exported.rawPayload), 'linked-source.png');
    expect(preview.blockingErrors).toEqual([]);
    expect(preview.character?.characterBook).toMatchObject({
      character_book_unknown: { preserve: true },
      entries: expect.arrayContaining([expect.objectContaining({
        id: 42,
        content: 'Current linked lore inside source PNG.',
        entry_extra: 'keep-character-book-entry',
      })]),
    });
  });
});
