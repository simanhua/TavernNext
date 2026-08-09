import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCharacterPng } from '@tavernnext/st-compat';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

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
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const app = createApp({
    ...options,
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, database, directory, repositories };
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
  const data = fixture.data as Record<string, unknown>;
  return encoder.encode(JSON.stringify({
    ...fixture,
    data: {
      ...data,
      name: 'Export / Aster',
      extensions: {
        ...(data.extensions as Record<string, unknown>),
        depth_prompt: { prompt: 'Typed Character depth prompt' },
      },
    },
  }));
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
      depthPrompt: 'Typed Character depth prompt',
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
    const { app, database, repositories } = await context({
      importMoveAssets: () => { throw new Error('injected Character asset move failure'); },
    });
    const { committed } = await inspectAndCommit(app);

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('rolls back an imported avatar blob when the provenance asset move fails', async () => {
    const { app, database, repositories } = await context({
      importMoveAssets: () => { throw new Error('injected Character asset move failure'); },
    });
    const card = JSON.parse(await readFile(join(fixtureRoot, 'v3.json'), 'utf8')) as Record<string, unknown>;
    const archive = zipSync({
      'card.json': encoder.encode(JSON.stringify(card)),
      'assets/avatar.gif': Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')),
    });
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('avatar.charx', archive, 'application/zip'),
    });
    expect(inspected.statusCode).toBe(200);

    const committed = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
  });

  it('rejects an imported avatar over its configured limit without persisting its owner or blob', async () => {
    const { app, database, repositories } = await context({ avatarMaxBytes: 64 });
    const card = JSON.parse(await readFile(join(fixtureRoot, 'v3.json'), 'utf8')) as Record<string, unknown>;
    const oversizedAvatar = new Uint8Array(65);
    oversizedAvatar.set(Buffer.from('GIF89a'));
    const archive = zipSync({ 'card.json': encoder.encode(JSON.stringify(card)), 'assets/avatar.gif': oversizedAvatar });
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('oversized-avatar.charx', archive, 'application/zip'),
    });
    expect(inspected.statusCode).toBe(200);

    const committed = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.characters.list()).toEqual([]);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
  });

  it('rejects a standalone Character Card whose PNG has metadata but no decodable raster', async () => {
    const { app, database, repositories } = await context();
    const card = JSON.parse(await readFile(join(fixtureRoot, 'v3.json'), 'utf8')) as Record<string, unknown>;
    const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const characterCard = Buffer.from(encodeCharacterPng(validPng, card, card));
    const noRaster = Buffer.from(encodePngChunks(extractPngChunks(characterCard).filter((chunk) => chunk.name !== 'IDAT')));
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('no-raster.png', noRaster, 'image/png'),
    });

    expect(inspected.statusCode).toBe(422);
    expect(inspected.json()).not.toHaveProperty('inspectionToken');
    expect(repositories.characters.list()).toEqual([]);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
  });

  it('exports edited deterministic V2/V3 JSON and PNG with safe filenames and exact content types', async () => {
    const { app } = await context();
    const { committed } = await inspectAndCommit(app);
    const id = committed.json().entityId as string;
    const edited = await app.inject({
      method: 'PATCH', url: `/api/characters/${id}`,
      payload: { revision: 0, patch: {
        description: 'Edited through the API.', depthPrompt: 'Edited dedicated depth prompt',
      } },
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
        expect(document.data.extensions.depth_prompt.prompt).toBe('Edited dedicated depth prompt');
        expect(document).toMatchObject({ top_unknown: { keep: 'v3-top' } });
      }
    }
    expect((await app.inject({ method: 'GET', url: `/api/characters/${id}/export?format=zip` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/characters/${characterId}/export?format=json-v2` })).statusCode).toBe(404);
  });

  it('uses a newly persisted current avatar ahead of the stale CharX source avatar', async () => {
    const { app, repositories } = await context();
    const card = JSON.parse(await readFile(join(fixtureRoot, 'v3.json'), 'utf8')) as Record<string, unknown>;
    const sourceAvatar = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
    const archive = zipSync({
      'card.json': encoder.encode(JSON.stringify(card)),
      'assets/avatar.gif': sourceAvatar,
    });
    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('avatar.charx', archive, 'application/zip'),
    });
    expect(inspected.statusCode).toBe(200);
    const committed = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });
    expect(committed.statusCode).toBe(201);
    const id = committed.json().entityId as string;

    const imported = repositories.characters.get(id)!;
    expect(imported.avatarPath).toMatch(new RegExp(`^assets/avatars/characters/${id}/[0-9a-f-]+\\.gif$`));
    const importedAvatar = await app.inject({ method: 'GET', url: `/api/characters/${id}/avatar` });
    expect(importedAvatar.statusCode).toBe(200);
    expect(importedAvatar.rawPayload).toEqual(Buffer.from(sourceAvatar));

    const currentAvatarPath = `assets/avatars/characters/${id}/018f0000-0000-7000-8000-000000000999.png`;
    const currentAvatarBytes = await sharp({
      create: { width: 2, height: 3, channels: 4, background: '#123456' },
    }).png().toBuffer();
    repositories.avatarAssets.put({
      path: currentAvatarPath,
      kind: 'characters',
      ownerId: id,
      mediaType: 'image/png',
      bytes: currentAvatarBytes,
    });
    expect(repositories.characters.update(id, 0, { avatarPath: currentAvatarPath })).toMatchObject({ ok: true });

    const exported = await app.inject({ method: 'GET', url: `/api/characters/${id}/export?format=png` });
    expect(exported.statusCode).toBe(200);
    expect(exported.rawPayload.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(exported.rawPayload.readUInt32BE(16)).toBe(2);
    expect(exported.rawPayload.readUInt32BE(20)).toBe(3);
  });

  it('copies a standalone PNG Character Card into its entity-bound avatar directory', async () => {
    const { app, repositories } = await context();
    const { committed: sourceCommit } = await inspectAndCommit(app);
    const sourceId = sourceCommit.json().entityId as string;
    const sourceCard = await app.inject({ method: 'GET', url: `/api/characters/${sourceId}/export?format=png` });
    expect(sourceCard.statusCode).toBe(200);

    const inspected = await app.inject({
      method: 'POST', url: '/api/imports/inspect', ...multipart('standalone-card.png', sourceCard.rawPayload, 'image/png'),
    });
    expect(inspected.statusCode).toBe(200);
    const imported = await app.inject({
      method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
    });
    expect(imported.statusCode).toBe(201);
    const importedId = imported.json().entityId as string;
    const row = repositories.characters.get(importedId)!;

    expect(row.avatarPath).toMatch(new RegExp(`^assets/avatars/characters/${importedId}/[0-9a-f-]+\\.png$`));
    const avatar = await app.inject({ method: 'GET', url: `/api/characters/${importedId}/avatar` });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.rawPayload).not.toEqual(sourceCard.rawPayload);
    expect(avatar.rawPayload.includes(Buffer.from('ccv3'))).toBe(false);
    expect(avatar.rawPayload.includes(Buffer.from('chara'))).toBe(false);
    expect(Uint8Array.from(avatar.rawPayload.subarray(0, 8))).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('serves Unicode filenames over a real HTTP listener with an ASCII fallback and RFC 5987 filename', async () => {
    const { app, repositories } = await context();
    const { committed } = await inspectAndCommit(app);
    const id = committed.json().entityId as string;
    expect(repositories.characters.update(id, 0, { name: '雪姬\r\nX-Injected: yes' })).toMatchObject({ ok: true });

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/api/characters/${id}/export?format=json-v3`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="___X-Injected_yes.json"; filename*=UTF-8\'\'%E9%9B%AA%E5%A7%AC_X-Injected_yes.json',
    );
    expect(response.headers.get('x-injected')).toBeNull();
    expect(await response.json()).toMatchObject({ data: { name: '雪姬\r\nX-Injected: yes' } });
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
