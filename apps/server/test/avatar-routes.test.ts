import { appendFileSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCharacterPng } from '@tavernnext/st-compat';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const encoder = new TextEncoder();
const characterId = '018f0000-0000-7000-8000-000000000951';
const personaId = '018f0000-0000-7000-8000-000000000952';
const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

function pngWithoutIdat(): Buffer {
  return Buffer.from(encodePngChunks(extractPngChunks(png).filter((chunk) => chunk.name !== 'IDAT')));
}

function pngWithInvalidCrc(): Buffer {
  const bytes = Buffer.from(png);
  const idat = bytes.indexOf(Buffer.from('IDAT'));
  bytes[idat + 4] ^= 0xff;
  return bytes;
}

function pngWithAdversarialDimensions(): Buffer {
  const chunks = extractPngChunks(png).map((chunk) => ({ name: chunk.name, data: Uint8Array.from(chunk.data) }));
  const ihdr = chunks.find((chunk) => chunk.name === 'IHDR')!;
  Buffer.from(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength).writeUInt32BE(0x7fff_ffff, 0);
  return Buffer.from(encodePngChunks(chunks));
}

function pngWithTallRaster(): Buffer {
  const height = 1_100_000;
  const chunks = extractPngChunks(png).map((chunk) => ({ name: chunk.name, data: Uint8Array.from(chunk.data) }));
  const ihdr = chunks.find((chunk) => chunk.name === 'IHDR')!;
  Buffer.from(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength).writeUInt32BE(height, 4);
  const idat = chunks.find((chunk) => chunk.name === 'IDAT')!;
  idat.data = deflateSync(Buffer.alloc(height * 3));
  return Buffer.from(encodePngChunks(chunks));
}

function pngIdatBytes(): Buffer {
  const idat = extractPngChunks(png).find((chunk) => chunk.name === 'IDAT');
  if (idat === undefined) throw new Error('PNG fixture has no IDAT');
  return Buffer.from(idat.data);
}

function pngWithIdatParts(parts: readonly Uint8Array[]): Buffer {
  const chunks = extractPngChunks(png).flatMap((chunk) => chunk.name === 'IDAT'
    ? parts.map((data) => ({ name: 'IDAT', data: Uint8Array.from(data) }))
    : [{ name: chunk.name, data: Uint8Array.from(chunk.data) }]);
  return Buffer.from(encodePngChunks(chunks));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context(options: Partial<NonNullable<Parameters<typeof createApp>[0]>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-avatar-routes-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  repositories.characters.create({
    id: characterId,
    name: 'Aster',
    description: 'Archivist',
    personality: 'Patient',
    scenario: 'Library',
    firstMessage: 'Welcome.',
    alternateGreetings: [],
    tags: [],
  });
  repositories.personas.create({
    id: personaId,
    name: 'Traveler',
    description: 'Curious visitor',
    isDefault: true,
  });
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

function multipart(fileName: string, bytes: Uint8Array, mediaType: string) {
  const boundary = '----tavernnext-avatar-routes-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function incompleteMultipart(fileName: string, bytes: Uint8Array, mediaType: string) {
  const boundary = '----tavernnext-avatar-routes-incomplete-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  return {
    payload: Buffer.concat([head, bytes]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('safe avatar routes', () => {
  it('stores and round-trips a Character PNG through a generated contained path', async () => {
    const { app, directory, repositories } = await context();

    const uploaded = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.png', png, 'image/png'),
    });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      id: characterId,
      revision: 1,
      name: 'Aster',
      avatarUrl: `/api/characters/${characterId}/avatar`,
    });
    expect(uploaded.json()).not.toHaveProperty('avatarPath');
    expect(uploaded.payload).not.toContain(directory);

    const stored = repositories.characters.get(characterId);
    expect(stored?.avatarPath).toMatch(
      new RegExp(`^assets/avatars/characters/${characterId}/[0-9a-f-]+\\.png$`),
    );
    expect(repositories.avatarAssets.getOwned(stored!.avatarPath!, 'characters', characterId)).toMatchObject({
      mediaType: 'image/png', bytes: Uint8Array.from(png),
    });
    await expect(readFile(resolve(directory, ...(stored?.avatarPath?.split('/') ?? [])))).rejects.toThrow();

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/characters/${characterId}/avatar`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.rawPayload).toEqual(png);
  });

  it('strips Character Card text chunks from a PNG uploaded as a public avatar', async () => {
    const { app } = await context();
    const card = Buffer.from(encodeCharacterPng(png, { name: 'Private V2' }, { name: 'Private V3' }));

    const uploaded = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('card.png', card, 'image/png'),
    });
    expect(uploaded.statusCode).toBe(200);

    const downloaded = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).not.toEqual(card);
    expect(downloaded.rawPayload.includes(Buffer.from('ccv3'))).toBe(false);
    expect(downloaded.rawPayload.includes(Buffer.from('chara'))).toBe(false);
  });

  it('strips Character Card text chunks from a descriptor-verified legacy PNG response', async () => {
    const { app, directory, repositories } = await context();
    const fileName = '018f0000-0000-7000-8000-000000000996.png';
    const storedPath = `assets/avatars/characters/${characterId}/${fileName}`;
    const ownerRoot = join(directory, 'assets', 'avatars', 'characters', characterId);
    const card = Buffer.from(encodeCharacterPng(png, { name: 'Private V2' }, { name: 'Private V3' }));
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(join(ownerRoot, fileName), card);
    expect(repositories.characters.update(characterId, 0, { avatarPath: storedPath })).toMatchObject({ ok: true });

    const downloaded = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });

    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).not.toEqual(card);
    expect(downloaded.rawPayload.includes(Buffer.from('ccv3'))).toBe(false);
    expect(downloaded.rawPayload.includes(Buffer.from('chara'))).toBe(false);
  });

  it('rejects structurally invalid PNG uploads without accumulating database contexts', async () => {
    const { app, database, repositories } = await context();
    const compressed = pngIdatBytes();
    for (const [caseName, bytes] of [
      ['zlib stream with trailing bytes', pngWithIdatParts([Buffer.concat([compressed, Buffer.from('deadbeef', 'hex')])])],
      ['additional zlib member', pngWithIdatParts([Buffer.concat([compressed, deflateSync(Buffer.alloc(0))])])],
      ['truncated zlib payload', pngWithIdatParts([compressed.subarray(0, -1)])],
      ['decoded raster beyond expected bound', pngWithIdatParts([deflateSync(Buffer.alloc(1024 * 1024))])],
      ['missing IDAT', pngWithoutIdat()],
      ['invalid CRC', pngWithInvalidCrc()],
      ['truncated stream', png.subarray(0, -5)],
      ['adversarial decoded dimensions', pngWithAdversarialDimensions()],
      ['adversarial tall raster', pngWithTallRaster()],
    ] as const) {
      const uploaded = await app.inject({
        method: 'PUT', url: `/api/characters/${characterId}/avatar?revision=0`,
        ...multipart('invalid.png', bytes, 'image/png'),
      });
      expect(uploaded.statusCode, caseName).toBe(415);
      expect(uploaded.json(), caseName).toEqual({ error: 'invalid_avatar_content' });
      expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get(), caseName).toEqual({ count: 0 });
    }
    const storedPath = `assets/avatars/characters/${characterId}/018f0000-0000-7000-8000-000000000993.png`;
    repositories.avatarAssets.put({
      path: storedPath, kind: 'characters', ownerId: characterId, mediaType: 'image/png', bytes: pngWithoutIdat(),
    });
    expect(repositories.characters.update(characterId, 0, { avatarPath: storedPath })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` })).statusCode).toBe(404);
  });

  it('rejects a real hard-linked legacy avatar alias when the platform supports hard links', async (testContext) => {
    const { app, directory, repositories } = await context();
    const fileName = '018f0000-0000-7000-8000-000000000992.png';
    const ownerRoot = join(directory, 'assets', 'avatars', 'characters', characterId);
    const source = join(directory, 'outside-owner.png');
    const alias = join(ownerRoot, fileName);
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(source, png);
    try {
      await link(source, alias);
    } catch {
      testContext.skip();
      return;
    }
    const storedPath = `assets/avatars/characters/${characterId}/${fileName}`;
    expect(repositories.characters.update(characterId, 0, { avatarPath: storedPath })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` })).statusCode).toBe(404);
  });

  it('bounds a legacy descriptor read to the verified file snapshot when the file grows after its first chunk', async () => {
    let appendAfterFirstChunk: () => void = () => undefined;
    const { app, directory, repositories } = await context({
      avatarLegacyAfterFirstChunk: () => appendAfterFirstChunk(),
    });
    const fileName = '018f0000-0000-7000-8000-000000000994.gif';
    const storedPath = `assets/avatars/characters/${characterId}/${fileName}`;
    const ownerRoot = join(directory, 'assets', 'avatars', 'characters', characterId);
    const absolutePath = join(ownerRoot, fileName);
    const verifiedBytes = Buffer.alloc(128 * 1024, 0x20);
    gif.copy(verifiedBytes, 0, 0, 6);
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(absolutePath, verifiedBytes);
    appendAfterFirstChunk = () => appendFileSync(absolutePath, Buffer.alloc(128 * 1024, 0x41));
    expect(repositories.characters.update(characterId, 0, { avatarPath: storedPath })).toMatchObject({ ok: true });

    const downloaded = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });

    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(verifiedBytes);
  });

  it('stores and round-trips a Persona GIF without crossing entity ownership', async () => {
    const { app, directory, repositories } = await context();

    const uploaded = await app.inject({
      method: 'PUT',
      url: `/api/personas/${personaId}/avatar?revision=0`,
      ...multipart('portrait.gif', gif, 'image/gif'),
    });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      id: personaId,
      revision: 1,
      name: 'Traveler',
      isDefault: true,
      avatarUrl: `/api/personas/${personaId}/avatar`,
    });
    expect(uploaded.json()).not.toHaveProperty('avatarPath');
    expect(uploaded.payload).not.toContain(directory);
    expect(repositories.personas.get(personaId)?.avatarPath).toMatch(
      new RegExp(`^assets/avatars/personas/${personaId}/[0-9a-f-]+\\.gif$`),
    );

    const downloaded = await app.inject({ method: 'GET', url: `/api/personas/${personaId}/avatar` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('image/gif');
    expect(downloaded.rawPayload).toEqual(gif);

    const wrongOwner = await app.inject({ method: 'GET', url: `/api/characters/${personaId}/avatar` });
    expect(wrongOwner.statusCode).toBe(404);
    expect(wrongOwner.payload).not.toContain(directory);
  });

  it.each([
    { fileName: 'portrait.jpg', mediaType: 'image/jpeg', bytes: jpeg, extension: 'jpg' },
    { fileName: 'portrait.webp', mediaType: 'image/webp', bytes: webp, extension: 'webp' },
  ])('accepts supported $mediaType magic and extension', async ({ fileName, mediaType, bytes, extension }) => {
    const { app, repositories } = await context();

    const uploaded = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart(fileName, bytes, mediaType),
    });

    expect(uploaded.statusCode).toBe(200);
    expect(repositories.characters.get(characterId)?.avatarPath).toMatch(new RegExp(`\\.${extension}$`));
    const downloaded = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe(mediaType);
    expect(downloaded.rawPayload).toEqual(bytes);
  });

  it('rejects stale revisions without replacing the current avatar or leaving files behind', async () => {
    const { app, database, directory, repositories } = await context();
    const first = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('first.png', png, 'image/png'),
    });
    expect(first.statusCode).toBe(200);
    const before = repositories.characters.get(characterId);
    const beforeAsset = repositories.avatarAssets.getOwned(before!.avatarPath!, 'characters', characterId);

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('stale.gif', gif, 'image/gif'),
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'conflict' });
    expect(repositories.characters.get(characterId)).toEqual(before);
    expect(repositories.avatarAssets.getOwned(before!.avatarPath!, 'characters', characterId)).toEqual(beforeAsset);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 1 });
    expect(stale.payload).not.toContain(directory);
  });

  it('rolls back the avatar blob when the owner revision changes after upload validation', async () => {
    let advanceRevision = () => undefined;
    const { app, database, repositories } = await context({
      avatarBeforeCommit: () => advanceRevision(),
    });
    advanceRevision = () => {
      expect(repositories.characters.update(characterId, 0, { description: 'Concurrent edit' })).toMatchObject({ ok: true });
    };

    const failed = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.png', png, 'image/png'),
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toEqual({ error: 'conflict' });
    expect(repositories.characters.get(characterId)).toMatchObject({ revision: 1, description: 'Concurrent edit' });
    expect(repositories.characters.get(characterId)).not.toHaveProperty('avatarPath');
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
  });

  it('rejects invalid query, media metadata, magic, and uploads over eight MiB without mutation', async () => {
    const { app, database, directory, repositories } = await context();
    const invalidRevision = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=../0`,
      ...multipart('portrait.png', png, 'image/png'),
    });
    expect(invalidRevision.statusCode).toBe(422);

    const wrongMedia = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.jpg', png, 'image/jpeg'),
    });
    expect(wrongMedia.statusCode).toBe(415);

    const wrongMagic = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.png', encoder.encode('not a png'), 'image/png'),
    });
    expect(wrongMagic.statusCode).toBe(415);

    const unsupported = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.txt', encoder.encode('text'), 'text/plain'),
    });
    expect(unsupported.statusCode).toBe(415);

    const oversized = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.png', new Uint8Array(8 * 1024 * 1024 + 1).fill(1), 'image/png'),
    });
    expect(oversized.statusCode).toBe(422);
    expect(oversized.json()).toEqual({ error: 'avatar_too_large' });

    expect(repositories.characters.get(characterId)).toMatchObject({ revision: 0 });
    expect(repositories.characters.get(characterId)).not.toHaveProperty('avatarPath');
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
    for (const response of [invalidRevision, wrongMedia, wrongMagic, unsupported, oversized]) {
      expect(response.payload).not.toContain(directory);
    }
  });

  it('refuses an oversized owner-bound database avatar instead of serving it', async () => {
    const { app, repositories } = await context({ avatarMaxBytes: 64 });
    const storedPath = `assets/avatars/characters/${characterId}/018f0000-0000-7000-8000-000000000995.gif`;
    const oversized = Buffer.alloc(65);
    gif.copy(oversized, 0, 0, 6);
    repositories.avatarAssets.put({ path: storedPath, kind: 'characters', ownerId: characterId, mediaType: 'image/gif', bytes: oversized });
    expect(repositories.characters.update(characterId, 0, { avatarPath: storedPath })).toMatchObject({ ok: true });

    const response = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('deletes only the exact owned avatar blob after a successful owner delete', async () => {
    const { app, database, repositories } = await context();
    expect((await app.inject({
      method: 'PUT', url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('portrait.png', png, 'image/png'),
    })).statusCode).toBe(200);
    const storedPath = repositories.characters.get(characterId)!.avatarPath!;

    expect((await app.inject({ method: 'DELETE', url: `/api/characters/${characterId}?revision=0` })).statusCode).toBe(409);
    expect(repositories.avatarAssets.getOwned(storedPath, 'characters', characterId)).toBeDefined();

    expect((await app.inject({ method: 'DELETE', url: `/api/characters/${characterId}?revision=1` })).statusCode).toBe(204);
    expect(repositories.avatarAssets.getOwned(storedPath, 'characters', characterId)).toBeUndefined();
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
  });

  it('returns only a generic 404 for missing owners and unsafe stored paths', async () => {
    const { app, directory, repositories } = await context();
    expect(repositories.characters.update(characterId, 0, { avatarPath: '../../outside-secret.png' }))
      .toMatchObject({ ok: true });

    const unsafe = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });
    expect(unsafe.statusCode).toBe(404);
    expect(unsafe.json()).toEqual({ error: 'not_found' });
    expect(unsafe.payload).not.toContain('outside-secret.png');
    expect(unsafe.payload).not.toContain(directory);

    const missingGet = await app.inject({
      method: 'GET',
      url: '/api/personas/018f0000-0000-7000-8000-000000000999/avatar',
    });
    expect(missingGet.statusCode).toBe(404);
    expect(missingGet.json()).toEqual({ error: 'not_found' });

    const missingPut = await app.inject({
      method: 'PUT',
      url: '/api/personas/018f0000-0000-7000-8000-000000000999/avatar?revision=0',
      ...multipart('portrait.gif', gif, 'image/gif'),
    });
    expect(missingPut.statusCode).toBe(404);
    expect(missingPut.json()).toEqual({ error: 'not_found' });
  });

  it('rejects a valid image outside the exact entity-bound avatar allowlist', async () => {
    const { app, directory, repositories } = await context();
    const importedPath = 'assets/imports/018f0000-0000-7000-8000-000000000998/character/avatar.png';
    await mkdir(join(directory, ...importedPath.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(directory, ...importedPath.split('/')), png);
    expect(repositories.characters.update(characterId, 0, { avatarPath: importedPath })).toMatchObject({ ok: true });

    const response = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('cleans its temporary file when a multipart stream ends prematurely', async () => {
    const { app, database, directory, repositories } = await context();

    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...incompleteMultipart('portrait.png', png, 'image/png'),
    });

    expect(malformed.statusCode).toBe(415);
    expect(malformed.json()).toEqual({ error: 'invalid_multipart_upload' });
    expect(repositories.characters.get(characterId)).toMatchObject({ revision: 0 });
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM avatar_assets').get()).toEqual({ count: 0 });
    expect(malformed.payload).not.toContain(directory);
  });

  it('does not follow a managed Character avatar path into a Persona owner directory', async () => {
    const { app, directory, repositories } = await context();
    const personaRoot = join(directory, 'assets', 'avatars', 'personas', personaId);
    await mkdir(personaRoot, { recursive: true });
    await writeFile(join(personaRoot, 'private.png'), png);
    const crossOwnerPath = `assets/avatars/characters/${characterId}/../../personas/${personaId}/private.png`;
    expect(repositories.characters.update(characterId, 0, { avatarPath: crossOwnerPath })).toMatchObject({ ok: true });

    const response = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(response.payload).not.toContain(directory);
  });

  it('keeps uploaded blobs out of linked avatar directories while rejecting legacy linked reads', async () => {
    const { app, directory, repositories } = await context();
    const personaRoot = join(directory, 'assets', 'avatars', 'personas', personaId);
    const characterRoot = join(directory, 'assets', 'avatars', 'characters', characterId);
    const fileName = '018f0000-0000-7000-8000-000000000997.png';
    await mkdir(personaRoot, { recursive: true });
    await mkdir(join(directory, 'assets', 'avatars', 'characters'), { recursive: true });
    await writeFile(join(personaRoot, fileName), png);
    await symlink(personaRoot, characterRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(repositories.characters.update(characterId, 0, {
      avatarPath: `assets/avatars/characters/${characterId}/${fileName}`,
    })).toMatchObject({ ok: true });

    const read = await app.inject({ method: 'GET', url: `/api/characters/${characterId}/avatar` });
    expect(read.statusCode).toBe(404);
    const upload = await app.inject({
      method: 'PUT', url: `/api/characters/${characterId}/avatar?revision=1`,
      ...multipart('replacement.png', png, 'image/png'),
    });
    expect(upload.statusCode).toBe(200);
    expect(await readdir(personaRoot)).toEqual([fileName]);
    const stored = repositories.characters.get(characterId)!;
    expect(repositories.avatarAssets.getOwned(stored.avatarPath!, 'characters', characterId)?.bytes).toEqual(Uint8Array.from(png));
  });

  it('never deletes a noncanonical legacy path while replacing an avatar', async () => {
    const { app, directory, repositories } = await context();
    const sentinel = join(directory, 'do-not-delete.png');
    await writeFile(sentinel, png);
    const unsafeOldPath = `assets/avatars/characters/${characterId}/../../../../do-not-delete.png`;
    expect(repositories.characters.update(characterId, 0, { avatarPath: unsafeOldPath })).toMatchObject({ ok: true });

    const uploaded = await app.inject({
      method: 'PUT', url: `/api/characters/${characterId}/avatar?revision=1`,
      ...multipart('replacement.png', png, 'image/png'),
    });
    expect(uploaded.statusCode).toBe(200);
    await expect(readFile(sentinel)).resolves.toEqual(png);
  });
});
