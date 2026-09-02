import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { SNAPSHOT_INTEGRITY_KEY_BYTES } from './db/snapshot-integrity.js';

export const SNAPSHOT_INTEGRITY_KEY_FILE = 'snapshot-integrity.key';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TEMPORARY_KEY_PREFIX = `.${SNAPSHOT_INTEGRITY_KEY_FILE}.`;
const TEMPORARY_KEY_SUFFIX = '.tmp';
const TEMPORARY_NAME_ATTEMPTS = 8;

export interface SnapshotIntegrityKeyPublicationOperations {
  /** Must atomically publish without replacing an existing destination. */
  publish(temporaryPath: string, publishedPath: string): void;
  /** Must durably flush directory-entry changes before returning. */
  syncDirectory(directoryPath: string): void;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensureSecureDataDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('Snapshot integrity storage is unavailable.');
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function' || before.uid !== process.getuid()) {
      throw new Error('Snapshot integrity storage is unavailable.');
    }
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    const after = lstatSync(path);
    if (!sameFile(before, after) || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error('Snapshot integrity storage is unavailable.');
    }
  }
}

function publishedPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new Error('Snapshot integrity storage is unavailable.');
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | directoryOnly | noFollow);
  } catch {
    throw new Error('Snapshot integrity storage is unavailable.');
  }
  try {
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    if (!opened.isDirectory() || !sameFile(opened, named)) {
      throw new Error('Snapshot integrity storage is unavailable.');
    }
    fsyncSync(descriptor);
  } catch {
    throw new Error('Snapshot integrity storage is unavailable.');
  } finally {
    closeSync(descriptor);
  }
}

function syncPublicationDirectory(
  directory: string,
  operations: Partial<SnapshotIntegrityKeyPublicationOperations>,
): void {
  if (process.platform === 'win32') return;
  (operations.syncDirectory ?? syncDirectory)(directory);
}

function temporaryKeyPath(directory: string): string {
  return join(
    directory,
    `${TEMPORARY_KEY_PREFIX}${process.pid}-${randomBytes(16).toString('hex')}${TEMPORARY_KEY_SUFFIX}`,
  );
}

function removeTemporaryKey(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new Error('Snapshot integrity key temporary could not be removed.');
  }
}

function temporaryOwnerPid(name: string): number | undefined {
  const identity = name.slice(TEMPORARY_KEY_PREFIX.length, -TEMPORARY_KEY_SUFFIX.length);
  const separator = identity.indexOf('-');
  if (separator <= 0) return undefined;
  const pidText = identity.slice(0, separator);
  const entropy = identity.slice(separator + 1);
  if (!/^\d+$/.test(pidText) || !/^[0-9a-f]{32}$/.test(entropy)) return undefined;
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function cleanupPublishedTemporaries(directory: string): boolean {
  let removed = false;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(TEMPORARY_KEY_PREFIX) || !name.endsWith(TEMPORARY_KEY_SUFFIX)) continue;
    const ownerPid = temporaryOwnerPid(name);
    // A winner may observe another creator while it is still writing. Only a
    // task whose process is definitely gone can be reclaimed as crash debris.
    if (ownerPid === undefined || processIsAlive(ownerPid)) continue;
    const path = join(directory, name);
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw new Error('Snapshot integrity storage is unavailable.');
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) continue;
    try {
      unlinkSync(path);
      removed = true;
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'EBUSY' && code !== 'EPERM') {
        throw new Error('Snapshot integrity storage is unavailable.');
      }
    }
  }
  return removed;
}

function writeTemporaryKey(directory: string): string {
  const key = randomBytes(SNAPSHOT_INTEGRITY_KEY_BYTES);
  let path: string | undefined;
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
    const candidate = temporaryKeyPath(directory);
    try {
      descriptor = openSync(candidate, 'wx', PRIVATE_FILE_MODE);
      path = candidate;
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw new Error('Snapshot integrity key could not be created.');
    }
  }
  if (path === undefined || descriptor === undefined) throw new Error('Snapshot integrity key could not be created.');
  try {
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile()) throw new Error('Snapshot integrity key could not be created.');
      let offset = 0;
      while (offset < key.length) {
        const written = writeSync(descriptor, key, offset, key.length - offset);
        if (written <= 0) throw new Error('Snapshot integrity key could not be created.');
        offset += written;
      }
      if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fsyncSync(descriptor);
      const named = lstatSync(path);
      if (!named.isFile() || named.isSymbolicLink() || !sameFile(opened, named)) {
        throw new Error('Snapshot integrity key could not be created.');
      }
    } finally {
      closeSync(descriptor);
    }
  } catch {
    try {
      removeTemporaryKey(path);
    } catch {
      // Preserve the creation failure; the private directory contains no published key.
    }
    throw new Error('Snapshot integrity key could not be created.');
  }
  try {
    const verified = readExistingKey(path);
    if (!Buffer.from(verified).equals(key)) throw new Error('Snapshot integrity key could not be created.');
    return path;
  } catch {
    try {
      removeTemporaryKey(path);
    } catch {
      // Preserve the creation failure; the private directory contains no published key.
    }
    throw new Error('Snapshot integrity key could not be created.');
  }
}

function readExistingKey(path: string): Uint8Array {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Snapshot integrity key is untrusted.');
  let posixUid: number | undefined;
  if (process.platform !== 'win32') {
    posixUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (posixUid === undefined || before.uid !== posixUid
      || (before.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error('Snapshot integrity key is untrusted.');
    }
  }

  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const access = process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY;
  let descriptor: number;
  try {
    descriptor = openSync(path, access | noFollow);
  } catch {
    throw new Error('Snapshot integrity key is untrusted.');
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Snapshot integrity key is untrusted.');
    if (process.platform !== 'win32') {
      if (opened.uid !== posixUid || (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw new Error('Snapshot integrity key is untrusted.');
      }
    }
    const bytes = Buffer.alloc(SNAPSHOT_INTEGRITY_KEY_BYTES + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(descriptor, bytes, read, bytes.length - read, null);
      if (count === 0) break;
      read += count;
    }
    const after = lstatSync(path);
    if (!sameFile(opened, after) || read !== SNAPSHOT_INTEGRITY_KEY_BYTES) {
      throw new Error('Snapshot integrity key is untrusted.');
    }
    // FlushFileBuffers on the published Windows handle makes the hard-link
    // durable before the process starts signing snapshots.
    if (process.platform === 'win32') fsyncSync(descriptor);
    return Uint8Array.from(bytes.subarray(0, SNAPSHOT_INTEGRITY_KEY_BYTES));
  } finally {
    closeSync(descriptor);
  }
}

function configuredKey(environment: NodeJS.ProcessEnv): Uint8Array | undefined {
  const encoded = environment.TAVERNNEXT_SNAPSHOT_INTEGRITY_KEY;
  if (encoded === undefined || encoded === '') return undefined;
  const bytes = Buffer.from(encoded, 'base64');
  const normalized = encoded.replace(/=+$/, '');
  if (bytes.length !== SNAPSHOT_INTEGRITY_KEY_BYTES
    || bytes.toString('base64').replace(/=+$/, '') !== normalized) {
    throw new Error('Invalid TAVERNNEXT_SNAPSHOT_INTEGRITY_KEY.');
  }
  return Uint8Array.from(bytes);
}

export function loadSnapshotIntegrityKey(
  dataDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  operations: Partial<SnapshotIntegrityKeyPublicationOperations> = {},
): Uint8Array {
  const fromEnvironment = configuredKey(environment);
  if (fromEnvironment !== undefined) return fromEnvironment;

  const directory = resolve(dataDir);
  ensureSecureDataDirectory(directory);
  const path = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
  if (publishedPathExists(path)) {
    const existing = readExistingKey(path);
    // This may be the first process after a publisher crashed between link(2)
    // and its directory fsync. Re-flushing is idempotent and closes that gap.
    syncPublicationDirectory(directory, operations);
    if (cleanupPublishedTemporaries(directory)) syncPublicationDirectory(directory, operations);
    return existing;
  }

  const temporaryPath = writeTemporaryKey(directory);
  try {
    try {
      (operations.publish ?? linkSync)(temporaryPath, path);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'EEXIST' && !(code === 'ENOENT' && publishedPathExists(path))) {
        throw new Error('Snapshot integrity key could not be created.');
      }
    }

    // A loser also flushes the winner's directory entry, so it cannot return a
    // key that was only visible in the filesystem cache when the winner paused.
    syncPublicationDirectory(directory, operations);
    const published = readExistingKey(path);
    if (cleanupPublishedTemporaries(directory)) {
      syncPublicationDirectory(directory, operations);
    }
    return published;
  } finally {
    if (removeTemporaryKey(temporaryPath)) {
      syncPublicationDirectory(directory, operations);
    }
  }
}

export function injectedSnapshotIntegrityKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== SNAPSHOT_INTEGRITY_KEY_BYTES) {
    throw new Error(`Snapshot integrity key must be exactly ${SNAPSHOT_INTEGRITY_KEY_BYTES} bytes.`);
  }
  return Uint8Array.from(key);
}
