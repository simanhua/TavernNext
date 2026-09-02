import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';

export const SECRET_STORE_FILE = 'secrets.json';
const SECRET_STORE_VERSION = 2;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const LOCK_NAME = `.${SECRET_STORE_FILE}.lock`;
const TEMPORARY_PREFIX = `.${SECRET_STORE_FILE}.`;
const TEMPORARY_SUFFIX = '.tmp';

export interface StoredProviderSecret {
  profileId: string;
  baseUrl: string;
  credential: { type: 'api_key'; key: string };
}

export interface SecretStore {
  set(secretRef: string, secret: StoredProviderSecret): void;
  get(secretRef: string): StoredProviderSecret | undefined;
  delete(secretRef: string): boolean;
  has(secretRef: string): boolean;
}

export interface SecretStoreOptions {
  beforePublish?(temporaryPath: string, publishedPath: string): void;
  lockTimeoutMs?: number;
}

interface SecretStoreDocument {
  version: 2;
  entries: Record<string, StoredProviderSecret>;
}

interface FileVersion {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensureDirectDirectory(path: string): void {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  let cursor = root;
  const suffix = relative(root, resolved);
  for (const component of suffix.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: PRIVATE_DIRECTORY_MODE });
    const stats = lstatSync(cursor);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Secret storage is unavailable.');
  }
  const stats = lstatSync(resolved);
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function' || stats.uid !== process.getuid()) {
      throw new Error('Secret storage is unavailable.');
    }
    chmodSync(resolved, PRIVATE_DIRECTORY_MODE);
    const hardened = lstatSync(resolved);
    if (!sameFile(stats, hardened) || (hardened.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error('Secret storage is unavailable.');
    }
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    if (!opened.isDirectory() || !sameFile(opened, named)) throw new Error('Secret storage is unavailable.');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validSecretRef(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateSecret(secret: StoredProviderSecret): StoredProviderSecret {
  if (typeof secret.profileId !== 'string' || secret.profileId === '' || secret.profileId.length > 512
    || typeof secret.baseUrl !== 'string' || secret.baseUrl.length > 4_096
    || typeof secret.credential !== 'object' || secret.credential === null
    || secret.credential.type !== 'api_key'
    || typeof secret.credential.key !== 'string' || secret.credential.key === ''
    || secret.credential.key.length > 1_048_576) {
    throw new Error('Invalid provider secret.');
  }
  try {
    new URL(secret.baseUrl);
  } catch {
    throw new Error('Invalid provider secret.');
  }
  return {
    profileId: secret.profileId,
    baseUrl: secret.baseUrl,
    credential: { type: 'api_key', key: secret.credential.key },
  };
}

function emptyDocument(): SecretStoreDocument {
  return { version: SECRET_STORE_VERSION, entries: Object.create(null) as Record<string, StoredProviderSecret> };
}

function parseDocument(bytes: Uint8Array): SecretStoreDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('Secret storage is untrusted.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Secret storage is untrusted.');
  const root = parsed as Record<string, unknown>;
  if ((root.version !== 1 && root.version !== SECRET_STORE_VERSION)
    || typeof root.entries !== 'object' || root.entries === null || Array.isArray(root.entries)) {
    throw new Error('Secret storage is untrusted.');
  }
  const entries = Object.create(null) as Record<string, StoredProviderSecret>;
  for (const [reference, candidate] of Object.entries(root.entries)) {
    if (!validSecretRef(reference) || typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('Secret storage is untrusted.');
    }
    try {
      const value = candidate as Record<string, unknown>;
      entries[reference] = root.version === 1
        ? validateSecret({
          profileId: String(value.providerId ?? ''),
          baseUrl: String(value.baseUrl ?? ''),
          credential: { type: 'api_key', key: String(value.value ?? '') },
        })
        : validateSecret(candidate as StoredProviderSecret);
    } catch {
      throw new Error('Secret storage is untrusted.');
    }
  }
  return { version: SECRET_STORE_VERSION, entries };
}

function readTrustedFile(path: string): Uint8Array | undefined {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new Error('Secret storage is unavailable.');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_STORE_BYTES) {
    throw new Error('Secret storage is untrusted.');
  }
  if (process.platform !== 'win32'
    && (typeof process.getuid !== 'function' || before.uid !== process.getuid() || (before.mode & 0o777) !== PRIVATE_FILE_MODE)) {
    throw new Error('Secret storage is untrusted.');
  }

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  } catch {
    throw new Error('Secret storage is untrusted.');
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened) || opened.size > MAX_STORE_BYTES) {
      throw new Error('Secret storage is untrusted.');
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = lstatSync(path);
    if (!sameFile(opened, after) || after.nlink !== 1 || offset !== opened.size) {
      throw new Error('Secret storage is untrusted.');
    }
    return Uint8Array.from(bytes.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}

function readDocument(path: string): SecretStoreDocument {
  const bytes = readTrustedFile(path);
  return bytes === undefined ? emptyDocument() : parseDocument(bytes);
}

function fileVersion(path: string): FileVersion | undefined {
  try {
    const stats = lstatSync(path);
    return {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mode: stats.mode,
      nlink: stats.nlink,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      birthtimeMs: stats.birthtimeMs,
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new Error('Secret storage is unavailable.');
  }
}

function sameVersion(left: FileVersion | undefined, right: FileVersion | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function readLatestDocument(path: string): { document: SecretStoreDocument; version: FileVersion | undefined } {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = fileVersion(path);
      const document = readDocument(path);
      const after = fileVersion(path);
      if (sameVersion(before, after)) return { document, version: after };
      lastError = new Error('Secret storage changed during read.');
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) sleep(1);
  }
  throw lastError;
}

function temporaryName(): string {
  return `${TEMPORARY_PREFIX}${process.pid}-${randomBytes(16).toString('hex')}${TEMPORARY_SUFFIX}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function ownerPid(name: string, prefix: string, suffix: string): number | undefined {
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  const identity = name.slice(prefix.length, -suffix.length);
  const separator = identity.indexOf('-');
  const pidText = separator < 0 ? identity : identity.slice(0, separator);
  if (!/^\d+$/.test(pidText)) return undefined;
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function cleanupCrashedTemporaries(directory: string): void {
  for (const name of readdirSync(directory)) {
    const pid = ownerPid(name, TEMPORARY_PREFIX, TEMPORARY_SUFFIX);
    if (pid === undefined || processIsAlive(pid)) continue;
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isFile() || stats.isSymbolicLink()) unlinkSync(path);
  }
}

function sleep(milliseconds: number): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}

function acquireLock(directory: string, timeoutMs: number): { path: string; stats: Stats } {
  const path = join(directory, LOCK_NAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'wx', PRIVATE_FILE_MODE);
      const identity = `${process.pid}-${randomBytes(16).toString('hex')}`;
      const bytes = Buffer.from(identity, 'utf8');
      writeSync(descriptor, bytes);
      if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fsyncSync(descriptor);
      const stats = fstatSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      return { path, stats };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (errorCode(error) !== 'EEXIST') throw new Error('Secret storage is unavailable.');
      let contents = '';
      try {
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 128) {
          throw new Error('Secret storage is unavailable.');
        }
        contents = readFileSync(path, 'utf8');
      } catch {
        throw new Error('Secret storage is unavailable.');
      }
      const pid = ownerPid(`${TEMPORARY_PREFIX}${contents}${TEMPORARY_SUFFIX}`, TEMPORARY_PREFIX, TEMPORARY_SUFFIX);
      if (pid !== undefined && !processIsAlive(pid)) {
        try {
          unlinkSync(path);
          syncDirectory(directory);
          continue;
        } catch {
          throw new Error('Secret storage is unavailable.');
        }
      }
      if (Date.now() >= deadline) throw new Error('Secret storage is busy.');
      sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLock(directory: string, lock: { path: string; stats: Stats }): void {
  try {
    const named = lstatSync(lock.path);
    if (!sameFile(named, lock.stats)) throw new Error('Secret storage is unavailable.');
    unlinkSync(lock.path);
    syncDirectory(directory);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new Error('Secret storage is unavailable.');
  }
}

function writeDocument(
  directory: string,
  path: string,
  document: SecretStoreDocument,
  options: SecretStoreOptions,
): void {
  const serialized = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
  if (serialized.byteLength > MAX_STORE_BYTES) throw new Error('Secret storage is unavailable.');
  const temporaryPath = join(directory, temporaryName());
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    let offset = 0;
    while (offset < serialized.byteLength) {
      const written = writeSync(descriptor, serialized, offset, serialized.byteLength - offset);
      if (written <= 0) throw new Error('Secret storage is unavailable.');
      offset += written;
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const verified = readTrustedFile(temporaryPath);
    if (verified === undefined || !Buffer.from(verified).equals(serialized)) throw new Error('Secret storage is unavailable.');
    options.beforePublish?.(temporaryPath, path);
    renameSync(temporaryPath, path);
    syncDirectory(directory);
    const published = readTrustedFile(path);
    if (published === undefined || !Buffer.from(published).equals(serialized)) throw new Error('Secret storage is unavailable.');
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        // Preserve the primary publication failure without exposing data or paths.
      }
    }
    throw new Error('Secret storage is unavailable.');
  }
}

class FileSecretStore implements SecretStore {
  private entries: Record<string, StoredProviderSecret>;
  private version: FileVersion | undefined;
  private readonly directory: string;
  private readonly path: string;

  constructor(dataDir: string, private readonly options: SecretStoreOptions) {
    this.directory = resolve(dataDir);
    ensureDirectDirectory(this.directory);
    this.path = join(this.directory, SECRET_STORE_FILE);
    const initial = readLatestDocument(this.path);
    this.entries = initial.document.entries;
    this.version = initial.version;
  }

  set(secretRef: string, secret: StoredProviderSecret): void {
    if (!validSecretRef(secretRef)) throw new Error('Invalid secret reference.');
    const validated = validateSecret(secret);
    const lock = acquireLock(this.directory, Math.max(1, Math.min(this.options.lockTimeoutMs ?? 2_000, 30_000)));
    try {
      cleanupCrashedTemporaries(this.directory);
      const current = readDocument(this.path);
      current.entries[secretRef] = validated;
      writeDocument(this.directory, this.path, current, this.options);
      this.entries = current.entries;
      this.version = fileVersion(this.path);
    } finally {
      releaseLock(this.directory, lock);
    }
  }

  get(secretRef: string): StoredProviderSecret | undefined {
    if (!validSecretRef(secretRef)) return undefined;
    // Atomic replacement gives readers a coherent old-or-new document. A cheap
    // identity/version check keeps live instances coherent; every change is
    // then reloaded through the no-follow and descriptor checks.
    const observed = fileVersion(this.path);
    if (!sameVersion(this.version, observed)) {
      const latest = readLatestDocument(this.path);
      this.entries = latest.document.entries;
      this.version = latest.version;
    }
    const secret = this.entries[secretRef];
    return secret === undefined ? undefined : { ...secret };
  }

  delete(secretRef: string): boolean {
    if (!validSecretRef(secretRef)) return false;
    const lock = acquireLock(this.directory, Math.max(1, Math.min(this.options.lockTimeoutMs ?? 2_000, 30_000)));
    try {
      cleanupCrashedTemporaries(this.directory);
      const current = readDocument(this.path);
      if (!Object.hasOwn(current.entries, secretRef)) {
        this.entries = current.entries;
        this.version = fileVersion(this.path);
        return false;
      }
      delete current.entries[secretRef];
      writeDocument(this.directory, this.path, current, this.options);
      this.entries = current.entries;
      this.version = fileVersion(this.path);
      return true;
    } finally {
      releaseLock(this.directory, lock);
    }
  }

  has(secretRef: string): boolean {
    return this.get(secretRef) !== undefined;
  }
}

export function createSecretStore(dataDir: string, options: SecretStoreOptions = {}): SecretStore {
  return new FileSecretStore(dataDir, options);
}
