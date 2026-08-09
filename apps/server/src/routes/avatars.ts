import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {} from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import { characterDetail, personaDetail } from './manager-dtos.js';

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 16;

interface AvatarEntity {
  id: string;
  revision: number;
  avatarPath?: string;
}

interface AvatarUpdateResult<T extends AvatarEntity> {
  ok: true;
  value: T;
}

interface AvatarUpdateFailure {
  ok: false;
  reason: 'not_found' | 'conflict';
}

interface AvatarAdapter<T extends AvatarEntity> {
  get(id: string): T | undefined;
  updateAvatar(id: string, revision: number, avatarPath: string): AvatarUpdateResult<T> | AvatarUpdateFailure;
  serialize(value: T): unknown;
}

type AvatarKind = 'characters' | 'personas';

interface ImageType {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  extension: 'png' | 'jpg' | 'webp' | 'gif';
  acceptedExtensions: readonly string[];
}

const imageTypes: readonly ImageType[] = [
  { mediaType: 'image/png', extension: 'png', acceptedExtensions: ['.png'] },
  { mediaType: 'image/jpeg', extension: 'jpg', acceptedExtensions: ['.jpg', '.jpeg'] },
  { mediaType: 'image/webp', extension: 'webp', acceptedExtensions: ['.webp'] },
  { mediaType: 'image/gif', extension: 'gif', acceptedExtensions: ['.gif'] },
];

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function declaredImageType(fileName: string, mediaType: string): ImageType | undefined {
  if (fileName.trim() === '' || fileName.includes('/') || fileName.includes('\\')) return undefined;
  const extension = extname(fileName).toLowerCase();
  return imageTypes.find((candidate) => (
    candidate.mediaType === mediaType.toLowerCase()
    && candidate.acceptedExtensions.includes(extension)
  ));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function detectedImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return imageTypes[0];
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return imageTypes[1];
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return imageTypes[2];
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return imageTypes[3];
  }
  return undefined;
}

function expectedRevision(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function managedOwnerPath(path: string, kind: AvatarKind, id: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  const prefix = `assets/avatars/${kind}/${id}/`;
  if (!normalized.startsWith(prefix)) return false;
  const fileName = normalized.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif)$/i.test(fileName);
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

async function hasOnlyDirectComponents(root: string, candidate: string): Promise<boolean> {
  const path = relative(root, candidate);
  if (path === '' || path.startsWith('..') || isAbsolute(path)) return false;
  let current = root;
  try {
    for (const segment of path.split(sep)) {
      current = join(current, segment);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return false;
      if (!sameResolvedPath(await realpath(current), current)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function append(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    offset += result.bytesWritten;
  }
}

interface StoredUpload {
  finalPath: string;
  storedPath: string;
}

class AvatarUploadStreamError extends Error {
  constructor() {
    super('invalid_multipart_upload');
    this.name = 'AvatarUploadStreamError';
  }
}

async function storeUpload(
  dataDir: string,
  kind: AvatarKind,
  id: string,
  extension: string,
  stream: AsyncIterable<Buffer>,
): Promise<{ upload?: StoredUpload; header: Buffer; tooLarge: boolean }> {
  await mkdir(dataDir, { recursive: true });
  const root = resolve(dataDir, 'assets', 'avatars', kind, id);
  await mkdir(root, { recursive: true });
  const [realDataDir, realRoot] = await Promise.all([realpath(dataDir), realpath(root)]);
  if (!contained(realDataDir, realRoot) || !sameResolvedPath(realRoot, root) || !await hasOnlyDirectComponents(resolve(dataDir), root)) {
    throw new Error('unsafe_avatar_storage');
  }

  const name = randomUUID();
  const temporaryPath = join(realRoot, `${name}.tmp`);
  const finalPath = join(realRoot, `${name}.${extension}`);
  const headerChunks: Buffer[] = [];
  let headerLength = 0;
  let total = 0;
  let tooLarge = false;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      let part: IteratorResult<Buffer>;
      try {
        part = await iterator.next();
      } catch {
        throw new AvatarUploadStreamError();
      }
      if (part.done) break;
      const value = part.value;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (headerLength < HEADER_BYTES) {
        const prefix = chunk.subarray(0, HEADER_BYTES - headerLength);
        headerChunks.push(prefix);
        headerLength += prefix.byteLength;
      }
      if (total > MAX_AVATAR_BYTES) {
        tooLarge = true;
        continue;
      }
      await append(handle, chunk);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const header = Buffer.concat(headerChunks);
  if (tooLarge) {
    await rm(temporaryPath, { force: true });
    return { header, tooLarge: true };
  }
  await rename(temporaryPath, finalPath);
  return {
    upload: { finalPath, storedPath: portablePath(realDataDir, finalPath) },
    header,
    tooLarge: false,
  };
}

async function safeStoredAvatar(
  dataDir: string,
  kind: AvatarKind,
  id: string,
  storedPath: string,
): Promise<{ stream: ReturnType<Awaited<ReturnType<typeof open>>['createReadStream']>; size: number; imageType: ImageType } | undefined> {
  if (storedPath.includes('\0') || isAbsolute(storedPath) || !managedOwnerPath(storedPath, kind, id)) return undefined;
  const lexicalRoot = resolve(dataDir);
  const lexicalPath = resolve(lexicalRoot, ...storedPath.replaceAll('\\', '/').split('/'));
  if (!contained(lexicalRoot, lexicalPath)) return undefined;
  try {
    const realRoot = await realpath(lexicalRoot);
    if (!sameResolvedPath(realRoot, lexicalRoot) || !await hasOnlyDirectComponents(lexicalRoot, lexicalPath)) return undefined;
    const before = await lstat(lexicalPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_AVATAR_BYTES) return undefined;
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    const handle = await open(lexicalPath, flags);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== before.size || metadata.dev !== before.dev || metadata.ino !== before.ino) {
        await handle.close();
        return undefined;
      }
      const header = Buffer.alloc(Math.min(HEADER_BYTES, metadata.size));
      await handle.read(header, 0, header.byteLength, 0);
      const imageType = detectedImageType(header);
      const extension = extname(lexicalPath).toLowerCase();
      if (imageType === undefined || !imageType.acceptedExtensions.includes(extension)) {
        await handle.close();
        return undefined;
      }
      return { stream: handle.createReadStream({ autoClose: true }), size: metadata.size, imageType };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch {
    return undefined;
  }
}

export async function readOwnerAvatarBytes(
  dataDir: string,
  kind: AvatarKind,
  id: string,
  storedPath: string,
): Promise<Uint8Array | undefined> {
  const avatar = await safeStoredAvatar(dataDir, kind, id, storedPath);
  if (avatar === undefined) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of avatar.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

async function removeReplacedManagedAvatar(
  dataDir: string,
  kind: AvatarKind,
  id: string,
  oldPath: string | undefined,
): Promise<void> {
  if (oldPath === undefined || !managedOwnerPath(oldPath, kind, id)) return;
  const root = resolve(dataDir);
  const lexicalPath = resolve(root, ...oldPath.replaceAll('\\', '/').split('/'));
  if (!contained(root, lexicalPath)) return;
  try {
    const [realRoot, path] = await Promise.all([realpath(root), realpath(lexicalPath)]);
    if (!sameResolvedPath(realRoot, root) || !sameResolvedPath(path, lexicalPath) || !await hasOnlyDirectComponents(root, lexicalPath)) return;
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) await rm(path, { force: true });
  } catch {
    // Replaced avatars are best-effort cleanup after the durable row was updated.
  }
}

function registerOwnerAvatarRoutes<T extends AvatarEntity>(
  app: FastifyInstance,
  dataDir: string,
  kind: AvatarKind,
  adapter: AvatarAdapter<T>,
): void {
  const route = `/api/${kind}/:id/avatar`;
  app.get<{ Params: { id: string } }>(route, async (request, reply) => {
    const owner = adapter.get(request.params.id);
    if (owner?.avatarPath === undefined) return reply.code(404).send({ error: 'not_found' });
    const avatar = await safeStoredAvatar(dataDir, kind, owner.id, owner.avatarPath);
    if (avatar === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply
      .type(avatar.imageType.mediaType)
      .header('content-length', String(avatar.size))
      .header('cache-control', 'private, no-cache')
      .send(avatar.stream);
  });

  app.put<{ Params: { id: string }; Querystring: { revision?: string } }>(route, async (request, reply) => {
    const revision = expectedRevision(request.query.revision);
    if (revision === undefined) return reply.code(422).send({ error: 'invalid_revision' });
    const owner = adapter.get(request.params.id);
    if (owner === undefined) return reply.code(404).send({ error: 'not_found' });
    if (owner.revision !== revision) return reply.code(409).send({ error: 'conflict' });
    if (!request.isMultipart()) return reply.code(415).send({ error: 'multipart_required' });

    let file;
    try {
      file = await request.file({ limits: { fileSize: MAX_AVATAR_BYTES + 1 }, throwFileSizeLimit: false });
    } catch {
      return reply.code(415).send({ error: 'invalid_multipart_upload' });
    }
    if (file === undefined || file.fieldname !== 'file') {
      return reply.code(415).send({ error: 'avatar_file_required' });
    }
    const declared = declaredImageType(file.filename, file.mimetype);
    if (declared === undefined) {
      file.file.resume();
      return reply.code(415).send({ error: 'unsupported_avatar_media' });
    }

    let stored: Awaited<ReturnType<typeof storeUpload>>;
    try {
      stored = await storeUpload(dataDir, kind, owner.id, declared.extension, file.file);
    } catch (error) {
      if (error instanceof AvatarUploadStreamError) {
        return reply.code(415).send({ error: 'invalid_multipart_upload' });
      }
      return reply.code(500).send({ error: 'avatar_storage_failed' });
    }
    if (stored.tooLarge || file.file.truncated) {
      if (stored.upload !== undefined) await rm(stored.upload.finalPath, { force: true });
      return reply.code(422).send({ error: 'avatar_too_large' });
    }
    const detected = detectedImageType(stored.header);
    if (stored.upload === undefined || detected?.mediaType !== declared.mediaType) {
      if (stored.upload !== undefined) await rm(stored.upload.finalPath, { force: true });
      return reply.code(415).send({ error: 'invalid_avatar_content' });
    }

    let updated: AvatarUpdateResult<T> | AvatarUpdateFailure;
    try {
      updated = adapter.updateAvatar(owner.id, revision, stored.upload.storedPath);
    } catch {
      await rm(stored.upload.finalPath, { force: true }).catch(() => undefined);
      return reply.code(500).send({ error: 'avatar_storage_failed' });
    }
    if (!updated.ok) {
      await rm(stored.upload.finalPath, { force: true });
      return reply.code(updated.reason === 'not_found' ? 404 : 409).send({ error: updated.reason });
    }
    await removeReplacedManagedAvatar(dataDir, kind, owner.id, owner.avatarPath);
    return reply.send(adapter.serialize(updated.value));
  });
}

export function registerAvatarRoutes(app: FastifyInstance, repositories: Repositories, dataDir: string): void {
  registerOwnerAvatarRoutes(app, dataDir, 'characters', {
    get: repositories.characters.get,
    updateAvatar: (id, revision, avatarPath) => repositories.characters.update(id, revision, { avatarPath }),
    serialize: characterDetail,
  });
  registerOwnerAvatarRoutes(app, dataDir, 'personas', {
    get: repositories.personas.get,
    updateAvatar: (id, revision, avatarPath) => repositories.personas.update(id, revision, { avatarPath }),
    serialize: personaDetail,
  });
}
