import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context() {
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
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, directory, repositories };
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
    const storedPath = resolve(directory, ...(stored?.avatarPath?.split('/') ?? []));
    await expect(readFile(storedPath)).resolves.toEqual(png);
    await expect(readdir(join(directory, 'assets', 'avatars', 'characters', characterId)))
      .resolves.toEqual([expect.stringMatching(/^[0-9a-f-]+\.png$/)]);

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/characters/${characterId}/avatar`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.rawPayload).toEqual(png);
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
    const { app, directory, repositories } = await context();
    const first = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('first.png', png, 'image/png'),
    });
    expect(first.statusCode).toBe(200);
    const before = repositories.characters.get(characterId);
    const avatarDirectory = join(directory, 'assets', 'avatars', 'characters', characterId);
    const filesBefore = await readdir(avatarDirectory);

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...multipart('stale.gif', gif, 'image/gif'),
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'conflict' });
    expect(repositories.characters.get(characterId)).toEqual(before);
    expect(await readdir(avatarDirectory)).toEqual(filesBefore);
    expect(stale.payload).not.toContain(directory);
  });

  it('rejects invalid query, media metadata, magic, and uploads over eight MiB without mutation', async () => {
    const { app, directory, repositories } = await context();
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
    const avatarRoot = join(directory, 'assets', 'avatars');
    await expect(readdir(avatarRoot, { recursive: true })).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.(png|jpg|jpeg|gif|webp)$/)]),
    );
    for (const response of [invalidRevision, wrongMedia, wrongMagic, unsupported, oversized]) {
      expect(response.payload).not.toContain(directory);
    }
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
    const { app, directory, repositories } = await context();

    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/characters/${characterId}/avatar?revision=0`,
      ...incompleteMultipart('portrait.png', png, 'image/png'),
    });

    expect(malformed.statusCode).toBe(415);
    expect(malformed.json()).toEqual({ error: 'invalid_multipart_upload' });
    expect(repositories.characters.get(characterId)).toMatchObject({ revision: 0 });
    const ownerRoot = join(directory, 'assets', 'avatars', 'characters', characterId);
    await expect(readdir(ownerRoot)).resolves.toEqual([]);
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

  it('rejects linked owner directories for both reads and uploads', async () => {
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
    expect(upload.statusCode).toBe(500);
    expect(upload.json()).toEqual({ error: 'avatar_storage_failed' });
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
