import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {} from '@fastify/multipart';
import { stripPngTextMetadata } from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import type { TavernDatabase } from '../db/client.js';
import { MAX_AVATAR_BYTES } from '../services/avatar-assets.js';
import { characterDetail, personaDetail } from './manager-dtos.js';

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

class AvatarUploadStreamError extends Error {
  constructor() {
    super('invalid_multipart_upload');
    this.name = 'AvatarUploadStreamError';
  }
}

async function readUpload(
  stream: AsyncIterable<Buffer>,
  maxAvatarBytes: number,
): Promise<{ bytes?: Buffer; header: Buffer; tooLarge: boolean }> {
  const headerChunks: Buffer[] = [];
  const chunks: Buffer[] = [];
  let headerLength = 0;
  let total = 0;
  let tooLarge = false;
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
      if (total > maxAvatarBytes) {
        tooLarge = true;
        continue;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    throw error;
  }

  const header = Buffer.concat(headerChunks);
  return tooLarge ? { header, tooLarge: true } : { bytes: Buffer.concat(chunks), header, tooLarge: false };
}

async function safeStoredAvatar(
  dataDir: string,
  kind: AvatarKind,
  id: string,
  storedPath: string,
  maxAvatarBytes = MAX_AVATAR_BYTES,
): Promise<{ stream: ReturnType<Awaited<ReturnType<typeof open>>['createReadStream']>; size: number; imageType: ImageType } | undefined> {
  if (storedPath.includes('\0') || isAbsolute(storedPath) || !managedOwnerPath(storedPath, kind, id)) return undefined;
  const lexicalRoot = resolve(dataDir);
  const lexicalPath = resolve(lexicalRoot, ...storedPath.replaceAll('\\', '/').split('/'));
  if (!contained(lexicalRoot, lexicalPath)) return undefined;
  try {
    const realRoot = await realpath(lexicalRoot);
    if (!sameResolvedPath(realRoot, lexicalRoot) || !await hasOnlyDirectComponents(lexicalRoot, lexicalPath)) return undefined;
    const before = await lstat(lexicalPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxAvatarBytes) return undefined;
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
      return { stream: handle.createReadStream({ autoClose: true, start: 0, end: metadata.size - 1 }), size: metadata.size, imageType };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch {
    return undefined;
  }
}

async function collectStoredAvatar(
  avatar: NonNullable<Awaited<ReturnType<typeof safeStoredAvatar>>>,
  storedPath: string,
  afterFirstChunk?: () => void,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of avatar.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > avatar.size) return undefined;
    chunks.push(bytes);
    if (chunks.length === 1) afterFirstChunk?.();
  }
  if (total !== avatar.size) return undefined;
  const bytes = Buffer.concat(chunks, total);
  const detected = detectedImageType(bytes);
  const extension = extname(storedPath).toLowerCase();
  return detected?.mediaType === avatar.imageType.mediaType && detected.acceptedExtensions.includes(extension)
    ? bytes
    : undefined;
}

export async function readOwnerAvatarBytes(
  repositories: Repositories,
  dataDir: string,
  kind: AvatarKind,
  id: string,
  storedPath: string,
): Promise<Uint8Array | undefined> {
  if (!managedOwnerPath(storedPath, kind, id)) return undefined;
  const stored = repositories.avatarAssets.getOwned(storedPath, kind, id);
  if (stored !== undefined) {
    if (stored.bytes.byteLength > MAX_AVATAR_BYTES) return undefined;
    const detected = detectedImageType(stored.bytes);
    const extension = extname(stored.path).toLowerCase();
    return detected !== undefined
      && detected.mediaType === stored.mediaType
      && detected.acceptedExtensions.includes(extension)
      ? Uint8Array.from(stored.bytes)
      : undefined;
  }
  const avatar = await safeStoredAvatar(dataDir, kind, id, storedPath);
  if (avatar === undefined) return undefined;
  const bytes = await collectStoredAvatar(avatar, storedPath);
  return bytes === undefined ? undefined : Uint8Array.from(bytes);
}

class AvatarUpdateTransactionError extends Error {
  constructor(readonly failure: AvatarUpdateFailure) {
    super(failure.reason);
  }
}

function registerOwnerAvatarRoutes<T extends AvatarEntity>(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  dataDir: string,
  kind: AvatarKind,
  adapter: AvatarAdapter<T>,
  beforeCommit?: () => void,
  maxAvatarBytes = MAX_AVATAR_BYTES,
  legacyAfterFirstChunk?: () => void,
): void {
  const route = `/api/${kind}/:id/avatar`;
  app.get<{ Params: { id: string } }>(route, async (request, reply) => {
    const owner = adapter.get(request.params.id);
    if (owner?.avatarPath === undefined) return reply.code(404).send({ error: 'not_found' });
    if (managedOwnerPath(owner.avatarPath, kind, owner.id)) {
      const stored = repositories.avatarAssets.getOwned(owner.avatarPath, kind, owner.id);
      if (stored !== undefined) {
        if (stored.bytes.byteLength > maxAvatarBytes) return reply.code(404).send({ error: 'not_found' });
        const detected = detectedImageType(stored.bytes);
        const extension = extname(stored.path).toLowerCase();
        if (detected === undefined || detected.mediaType !== stored.mediaType || !detected.acceptedExtensions.includes(extension)) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return reply
          .type(stored.mediaType)
          .header('content-length', String(stored.bytes.byteLength))
          .header('cache-control', 'private, no-cache')
          .send(Buffer.from(stored.bytes));
      }
    }
    const avatar = await safeStoredAvatar(dataDir, kind, owner.id, owner.avatarPath, maxAvatarBytes);
    if (avatar === undefined) return reply.code(404).send({ error: 'not_found' });
    const verifiedBytes = await collectStoredAvatar(avatar, owner.avatarPath, legacyAfterFirstChunk);
    if (verifiedBytes === undefined) return reply.code(404).send({ error: 'not_found' });
    let publicBytes = verifiedBytes;
    if (avatar.imageType.mediaType === 'image/png') {
      try {
        publicBytes = Buffer.from(stripPngTextMetadata(publicBytes));
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    }
    return reply
      .type(avatar.imageType.mediaType)
      .header('content-length', String(publicBytes.byteLength))
      .header('cache-control', 'private, no-cache')
      .send(publicBytes);
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
      file = await request.file({ limits: { fileSize: maxAvatarBytes + 1 }, throwFileSizeLimit: false });
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

    let stored: Awaited<ReturnType<typeof readUpload>>;
    try {
      stored = await readUpload(file.file, maxAvatarBytes);
    } catch (error) {
      if (error instanceof AvatarUploadStreamError) {
        return reply.code(415).send({ error: 'invalid_multipart_upload' });
      }
      return reply.code(500).send({ error: 'avatar_storage_failed' });
    }
    if (stored.tooLarge || file.file.truncated) {
      return reply.code(422).send({ error: 'avatar_too_large' });
    }
    const detected = detectedImageType(stored.header);
    if (stored.bytes === undefined || detected?.mediaType !== declared.mediaType) {
      return reply.code(415).send({ error: 'invalid_avatar_content' });
    }
    let publicBytes = stored.bytes;
    if (declared.mediaType === 'image/png') {
      try {
        publicBytes = Buffer.from(stripPngTextMetadata(stored.bytes));
      } catch {
        return reply.code(415).send({ error: 'invalid_avatar_content' });
      }
    }

    const storedPath = `assets/avatars/${kind}/${owner.id}/${randomUUID()}.${declared.extension}`;
    let updated: AvatarUpdateResult<T>;
    try {
      beforeCommit?.();
      updated = database.transaction(() => {
        repositories.avatarAssets.put({
          path: storedPath,
          kind,
          ownerId: owner.id,
          mediaType: declared.mediaType,
          bytes: Uint8Array.from(publicBytes),
        });
        const result = adapter.updateAvatar(owner.id, revision, storedPath);
        if (!result.ok) throw new AvatarUpdateTransactionError(result);
        if (owner.avatarPath !== undefined) repositories.avatarAssets.deleteOwned(owner.avatarPath, kind, owner.id);
        return result;
      });
    } catch (error) {
      if (error instanceof AvatarUpdateTransactionError) {
        return reply.code(error.failure.reason === 'not_found' ? 404 : 409).send({ error: error.failure.reason });
      }
      return reply.code(500).send({ error: 'avatar_storage_failed' });
    }
    return reply.send(adapter.serialize(updated.value));
  });
}

export function registerAvatarRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  dataDir: string,
  beforeCommit?: () => void,
  maxAvatarBytes = MAX_AVATAR_BYTES,
  legacyAfterFirstChunk?: () => void,
): void {
  if (!Number.isSafeInteger(maxAvatarBytes) || maxAvatarBytes <= 0) {
    throw new Error('Invalid avatar byte limit');
  }
  registerOwnerAvatarRoutes(app, database, repositories, dataDir, 'characters', {
    get: repositories.characters.get,
    updateAvatar: (id, revision, avatarPath) => repositories.characters.update(id, revision, { avatarPath }),
    serialize: characterDetail,
  }, beforeCommit, maxAvatarBytes, legacyAfterFirstChunk);
  registerOwnerAvatarRoutes(app, database, repositories, dataDir, 'personas', {
    get: repositories.personas.get,
    updateAvatar: (id, revision, avatarPath) => repositories.personas.update(id, revision, { avatarPath }),
    serialize: personaDetail,
  }, beforeCommit, maxAvatarBytes, legacyAfterFirstChunk);
}
