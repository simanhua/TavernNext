import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';

const encoder = new TextEncoder();
const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'characters');
const characterId = '018f0000-0000-7000-8000-000000000801';
const personaOne = '018f0000-0000-7000-8000-000000000802';
const personaTwo = '018f0000-0000-7000-8000-000000000803';
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context(options: Partial<NonNullable<Parameters<typeof createApp>[0]>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-character-api-'));
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
  const boundary = '----tavernnext-character-api-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function v3Bytes(): Promise<Uint8Array> {
  const fixture = JSON.parse(await readFile(join(fixtureRoot, 'v3.json'), 'utf8')) as Record<string, unknown>;
  return encoder.encode(JSON.stringify({ ...fixture, data: { ...(fixture.data as object), name: 'Export / Aster' } }));
}

async function inspectAndCommit(app: ReturnType<typeof createApp>) {
  const inspected = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('aster.v3.json', await v3Bytes()) });
  expect(inspected.statusCode).toBe(200);
  expect(inspected.json()).toMatchObject({
    detected: { kind: 'character', version: '3.0' },
    normalizedPreview: {
      name: 'Export / Aster',
      description: 'A synthetic V3 archivist.',
      systemPrompt: 'Retain compatible metadata.',
      creatorNotes: 'V3 creator note',
      extensions: { fixture_extension: { mode: 'v3' } },
    },
    blockingErrors: [],
  });
  const committed = await app.inject({
    method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
  });
  return { inspected, committed };
}

describe('typed Character import and export API', () => {
  it('registers the Character handler by default and atomically commits a normalized row plus source artifact', async () => {
    const { app, repositories } = await context();
    const { committed } = await inspectAndCommit(app);

    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({ entityId: expect.any(String), artifactId: expect.any(String) });
    const character = repositories.characters.get(committed.json().entityId as string);
    expect(character).toMatchObject({
      name: 'Export / Aster',
      examples: '<START>\n{{char}}: Every byte is accounted for.',
      systemPrompt: 'Retain compatible metadata.',
      postHistoryInstructions: 'Prefer deterministic output.',
      creatorNotes: 'V3 creator note',
      creator: 'TavernNext tests',
      characterVersion: '3.1-test',
    });
    expect(character?.compatibility?.rawPayload).toMatchObject({
      sourceFormat: 'json',
      rawPayloads: { document: expect.any(Object) },
      unknownFields: {
        topLevel: { top_unknown: { keep: 'v3-top' } },
        data: expect.objectContaining({ data_unknown: { keep: 'v3' } }),
      },
    });
    expect(repositories.importArtifacts.list()).toEqual([
      expect.objectContaining({ entityId: character?.id, sourceName: 'aster.v3.json' }),
    ]);
  });

  it('rolls back the native Character and ImportArtifact when the final asset move fails', async () => {
    const { app, repositories } = await context({
      importMoveAssets: () => { throw new Error('injected Character asset move failure'); },
    });
    const { committed } = await inspectAndCommit(app);

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('exports edited deterministic V2/V3 JSON and PNG with safe filenames and exact content types', async () => {
    const { app } = await context();
    const { committed } = await inspectAndCommit(app);
    const id = committed.json().entityId as string;
    const edited = await app.inject({
      method: 'PATCH', url: `/api/characters/${id}`,
      payload: { revision: 0, patch: { description: 'Edited through the API.' } },
    });
    expect(edited.statusCode).toBe(200);

    for (const [format, contentType, suffix] of [
      ['json-v2', 'application/json; charset=utf-8', '.json'],
      ['json-v3', 'application/json; charset=utf-8', '.json'],
      ['png', 'image/png', '.png'],
    ] as const) {
      const exported = await app.inject({ method: 'GET', url: `/api/characters/${id}/export?format=${format}` });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain(contentType);
      expect(exported.headers['content-disposition']).toMatch(/^attachment; filename="Export_Aster\.(?:json|png)"$/);
      expect(exported.headers['content-disposition']).toContain(suffix);
      if (format === 'png') {
        expect(Uint8Array.from(exported.rawPayload.subarray(0, 8))).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
      } else {
        const document = exported.json();
        expect(document.data.description).toBe('Edited through the API.');
        expect(document).toMatchObject({ top_unknown: { keep: 'v3-top' } });
      }
    }
    expect((await app.inject({ method: 'GET', url: `/api/characters/${id}/export?format=zip` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/characters/${characterId}/export?format=json-v2` })).statusCode).toBe(404);
  });
});

describe('TavernNext-native Persona defaults', () => {
  it('maintains one default across create, update, and delete without creating compatibility artifacts', async () => {
    const { app, repositories } = await context();
    const first = await app.inject({
      method: 'POST', url: '/api/personas',
      payload: { id: personaOne, name: 'First native Persona', description: 'Synthetic', isDefault: false },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ isDefault: true });
    const second = await app.inject({
      method: 'POST', url: '/api/personas',
      payload: { id: personaTwo, name: 'Second native Persona', description: 'Synthetic', isDefault: true },
    });
    expect(second.statusCode).toBe(201);
    expect(repositories.personas.get(personaOne)).toMatchObject({ isDefault: false });
    expect(repositories.personas.get(personaTwo)).toMatchObject({ isDefault: true });

    const switched = await app.inject({
      method: 'PATCH', url: `/api/personas/${personaOne}`,
      payload: { revision: 1, patch: { isDefault: true } },
    });
    expect(switched.statusCode).toBe(200);
    expect(repositories.personas.get(personaOne)).toMatchObject({ isDefault: true });
    expect(repositories.personas.get(personaTwo)).toMatchObject({ isDefault: false });

    const removed = await app.inject({ method: 'DELETE', url: `/api/personas/${personaOne}?revision=2` });
    expect(removed.statusCode).toBe(204);
    expect(repositories.personas.get(personaTwo)).toMatchObject({ isDefault: true });
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/personas/${personaTwo}/export?format=json` })).statusCode).toBe(404);
  });
});
