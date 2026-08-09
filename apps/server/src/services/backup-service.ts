import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createDatabase } from '../db/client.js';

export const BACKUP_METADATA_FILE = 'metadata.json';
const BACKUP_FORMAT_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RETAINED_AUTOMATIC_BACKUPS = 5;
const COPY_BUFFER_BYTES = 64 * 1024;
const DATABASE_LOCK_SUFFIX = '.tavernnext-owner.lock';
const PUBLISHED_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{16}-pre-migration$/;

export interface BackupFileMetadata {
  file: string;
  bytes: number;
  sha256: string;
}

export interface BackupMetadata {
  formatVersion: 1;
  kind: 'pre_migration';
  createdAt: string;
  schemaVersion: number | null;
  checkpoint: 'connection_closed' | 'wal_checkpointed';
  database: BackupFileMetadata;
  wal?: BackupFileMetadata;
  integrityCheck: 'ok';
}

export interface CreatePreMigrationBackupOptions {
  dataDir: string;
  databasePath: string;
  schemaVersion: number | null;
  clock?: () => Date;
  /** Test seam and collision-resistant publication identifier. */
  backupId?: () => string;
  databaseOwnership?: DatabaseOwnership;
}

export interface PreMigrationBackup {
  path: string;
  metadata: BackupMetadata;
}

export interface DatabaseOwnership {
  readonly databasePath: string;
  assertHeld(databasePath: string): void;
  release(): void;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function sleep(milliseconds: number): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}

function lockOwner(path: string): { pid: number; stats: Stats } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 128) {
    throw new Error('Database ownership lock is untrusted.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) {
      throw new Error('Database ownership lock is untrusted.');
    }
    const bytes = Buffer.alloc(129);
    let count = 0;
    while (count < opened.size) {
      const read = readSync(descriptor, bytes, count, opened.size - count, null);
      if (read <= 0) throw new Error('Database ownership lock is untrusted.');
      count += read;
    }
    const after = lstatSync(path);
    if (!sameFile(opened, after) || after.nlink !== 1 || count !== opened.size) {
      throw new Error('Database ownership lock is untrusted.');
    }
    const match = /^(\d+)-[0-9a-f]{32}$/.exec(bytes.subarray(0, count).toString('utf8'));
    const pid = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Database ownership lock is untrusted.');
    return { pid, stats: opened };
  } finally {
    closeSync(descriptor);
  }
}

export function acquireDatabaseOwnership(databasePath: string, timeoutMs = 2_000): DatabaseOwnership {
  const resolvedDatabasePath = resolve(databasePath);
  mkdirSync(dirname(resolvedDatabasePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const lockPath = `${resolvedDatabasePath}${DATABASE_LOCK_SUFFIX}`;
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 30_000));
  for (;;) {
    let descriptor: number | undefined;
    let createdStats: Stats | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', PRIVATE_FILE_MODE);
      const identity = Buffer.from(`${process.pid}-${randomBytes(16).toString('hex')}`, 'utf8');
      let offset = 0;
      while (offset < identity.byteLength) {
        const written = writeSync(descriptor, identity, offset, identity.byteLength - offset);
        if (written <= 0) throw new Error('Database ownership lock failed.');
        offset += written;
      }
      if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fsyncSync(descriptor);
      const stats = fstatSync(descriptor);
      createdStats = stats;
      closeSync(descriptor);
      descriptor = undefined;
      const named = lstatSync(lockPath);
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameFile(named, stats)) {
        throw new Error('Database ownership lock was replaced.');
      }
      let released = false;
      return {
        databasePath: resolvedDatabasePath,
        assertHeld(candidate) {
          if (released || resolve(candidate) !== resolvedDatabasePath) throw new Error('Database ownership was lost.');
          const named = lstatSync(lockPath);
          if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameFile(named, stats)) {
            throw new Error('Database ownership was lost.');
          }
        },
        release() {
          if (released) return;
          const named = lstatSync(lockPath);
          if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameFile(named, stats)) {
            throw new Error('Database ownership was lost.');
          }
          unlinkSync(lockPath);
          syncDirectory(dirname(lockPath));
          released = true;
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          createdStats ??= fstatSync(descriptor);
        } catch {
          // The primary lock failure remains authoritative.
        }
        closeSync(descriptor);
      }
      if (createdStats !== undefined) {
        try {
          const named = lstatSync(lockPath);
          if (sameFile(named, createdStats)) unlinkSync(lockPath);
        } catch {
          // Never unlink a replacement and never mask the primary failure.
        }
      }
      if (errorCode(error) !== 'EEXIST') throw error instanceof Error ? error : new Error('Database ownership lock failed.');
      let owner: { pid: number; stats: Stats };
      try {
        owner = lockOwner(lockPath);
      } catch {
        throw new Error('Database ownership lock is untrusted.');
      }
      if (!processIsAlive(owner.pid)) {
        const named = lstatSync(lockPath);
        if (!sameFile(named, owner.stats)) throw new Error('Database ownership lock changed.');
        unlinkSync(lockPath);
        syncDirectory(dirname(lockPath));
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Database is already in use.');
      sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Backup storage is unavailable.');
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function' || stats.uid !== process.getuid()) throw new Error('Backup storage is unavailable.');
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
  }
}

function ensureBackupRoot(dataDir: string): string {
  const root = join(resolve(dataDir), 'backups');
  try {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Backup storage is unavailable.');
    if (process.platform !== 'win32') {
      if (typeof process.getuid !== 'function' || stats.uid !== process.getuid()) throw new Error('Backup storage is unavailable.');
      chmodSync(root, PRIVATE_DIRECTORY_MODE);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    ensurePrivateDirectory(root);
  }
  return root;
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    if (!opened.isDirectory() || !sameFile(opened, named)) throw new Error('Backup storage is unavailable.');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyFileVerified(source: string, destination: string): BackupFileMetadata {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Database backup source is untrusted.');
  const sourceDescriptor = openSync(
    source,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  let destinationDescriptor: number | undefined;
  try {
    const opened = fstatSync(sourceDescriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened) || !Number.isSafeInteger(opened.size)) {
      throw new Error('Database backup source is untrusted.');
    }
    destinationDescriptor = openSync(destination, 'wx', PRIVATE_FILE_MODE);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    while (copied < opened.size) {
      const wanted = Math.min(buffer.byteLength, opened.size - copied);
      const count = readSync(sourceDescriptor, buffer, 0, wanted, null);
      if (count <= 0) throw new Error('Database backup source changed during copy.');
      digest.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        const written = writeSync(destinationDescriptor, buffer, offset, count - offset);
        if (written <= 0) throw new Error('Backup storage is unavailable.');
        offset += written;
      }
      copied += count;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, null) !== 0) throw new Error('Database backup source changed during copy.');
    const after = lstatSync(source);
    if (!sameFile(opened, after) || after.size !== opened.size || after.nlink !== 1) {
      throw new Error('Database backup source changed during copy.');
    }
    if (process.platform !== 'win32') fchmodSync(destinationDescriptor, PRIVATE_FILE_MODE);
    fsyncSync(destinationDescriptor);
    return { file: basename(destination), bytes: copied, sha256: digest.digest('hex') };
  } finally {
    closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
  }
}

function hashFileVerified(path: string): BackupFileMetadata {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size)) {
    throw new Error('Backup file is untrusted.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw new Error('Backup file is untrusted.');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let read = 0;
    while (read < opened.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, opened.size - read), null);
      if (count <= 0) throw new Error('Backup file changed while hashing.');
      digest.update(buffer.subarray(0, count));
      read += count;
    }
    if (readSync(descriptor, buffer, 0, 1, null) !== 0) throw new Error('Backup file changed while hashing.');
    const after = lstatSync(path);
    if (!sameFile(opened, after) || after.size !== opened.size || after.nlink !== 1) {
      throw new Error('Backup file changed while hashing.');
    }
    return { file: basename(path), bytes: read, sha256: digest.digest('hex') };
  } finally {
    closeSync(descriptor);
  }
}

function metadataMatches(actual: BackupFileMetadata, expected: BackupFileMetadata): boolean {
  return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}

function readExactly(descriptor: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, position + offset);
    if (count <= 0) throw new Error('Write-ahead log is incomplete.');
    offset += count;
  }
}

function writeExactly(descriptor: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const count = writeSync(descriptor, buffer, offset, buffer.byteLength - offset, position + offset);
    if (count <= 0) throw new Error('Backup storage is unavailable.');
    offset += count;
  }
}

function validPageSize(value: number): boolean {
  return value === 65_536 || (value >= 512 && value <= 32_768 && (value & (value - 1)) === 0);
}

function databasePageSize(descriptor: number): number {
  const header = Buffer.alloc(100);
  readExactly(descriptor, header, 0);
  if (header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('Database backup source is invalid.');
  const encoded = header.readUInt16BE(16);
  const pageSize = encoded === 1 ? 65_536 : encoded;
  if (!validPageSize(pageSize)) throw new Error('Database backup source is invalid.');
  return pageSize;
}

function updateWalChecksum(
  bytes: Uint8Array,
  byteOrder: 'big' | 'little',
  initial: readonly [number, number],
): [number, number] {
  if (bytes.byteLength % 8 !== 0) throw new Error('Write-ahead log checksum input is invalid.');
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [first, second] = initial;
  for (let offset = 0; offset < view.byteLength; offset += 8) {
    const left = byteOrder === 'big' ? view.readUInt32BE(offset) : view.readUInt32LE(offset);
    const right = byteOrder === 'big' ? view.readUInt32BE(offset + 4) : view.readUInt32LE(offset + 4);
    first = (first + left + second) >>> 0;
    second = (second + right + first) >>> 0;
  }
  return [first, second];
}

function applyCommittedWal(databasePath: string, walPath: string, walBytes: number): BackupFileMetadata {
  if (walBytes === 0) return hashFileVerified(databasePath);
  if (walBytes < 32) throw new Error('Write-ahead log is invalid.');
  const walDescriptor = openSync(walPath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  const databaseDescriptor = openSync(databasePath, constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const walOpened = fstatSync(walDescriptor);
    const databaseOpened = fstatSync(databaseDescriptor);
    if (!walOpened.isFile() || walOpened.nlink !== 1 || walOpened.size !== walBytes
      || !databaseOpened.isFile() || databaseOpened.nlink !== 1) {
      throw new Error('Backup files are untrusted.');
    }
    const header = Buffer.alloc(32);
    readExactly(walDescriptor, header, 0);
    const magic = header.readUInt32BE(0);
    const byteOrder = magic === 0x377f0683 ? 'big' : magic === 0x377f0682 ? 'little' : undefined;
    if (byteOrder === undefined || header.readUInt32BE(4) !== 3_007_000) throw new Error('Write-ahead log is invalid.');
    const encodedPageSize = header.readUInt32BE(8);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    if (!validPageSize(pageSize) || pageSize !== databasePageSize(databaseDescriptor)) {
      throw new Error('Write-ahead log is invalid.');
    }
    const frameSize = 24 + pageSize;
    const completeFrames = Math.floor((walBytes - 32) / frameSize);
    const initialPages = databaseOpened.size / pageSize;
    if (!Number.isSafeInteger(initialPages)) throw new Error('Database backup source is invalid.');
    let checksum = updateWalChecksum(header.subarray(0, 24), byteOrder, [0, 0]);
    if (header.readUInt32BE(24) !== checksum[0] || header.readUInt32BE(28) !== checksum[1]) {
      throw new Error('Write-ahead log header checksum failed.');
    }
    const firstSalt = header.readUInt32BE(16);
    const secondSalt = header.readUInt32BE(20);
    const frameHeader = Buffer.alloc(24);
    const page = Buffer.allocUnsafe(pageSize);
    let transactionStart = 32;
    for (let frameIndex = 0; frameIndex < completeFrames; frameIndex += 1) {
      const position = 32 + frameIndex * frameSize;
      readExactly(walDescriptor, frameHeader, position);
      readExactly(walDescriptor, page, position + 24);
      if (frameHeader.readUInt32BE(0) === 0
        || frameHeader.readUInt32BE(8) !== firstSalt
        || frameHeader.readUInt32BE(12) !== secondSalt) {
        break;
      }
      const nextHeaderChecksum = updateWalChecksum(frameHeader.subarray(0, 8), byteOrder, checksum);
      const nextChecksum = updateWalChecksum(page, byteOrder, nextHeaderChecksum);
      if (frameHeader.readUInt32BE(16) !== nextChecksum[0] || frameHeader.readUInt32BE(20) !== nextChecksum[1]) {
        break;
      }
      checksum = nextChecksum;
      const committedPages = frameHeader.readUInt32BE(4);
      if (committedPages === 0) continue;
      const checkpointBytes = committedPages * pageSize;
      if (!Number.isSafeInteger(checkpointBytes) || checkpointBytes < 100
        || committedPages > initialPages + completeFrames) {
        break;
      }
      for (let replay = transactionStart; replay <= position; replay += frameSize) {
        readExactly(walDescriptor, frameHeader, replay);
        const pageNumber = frameHeader.readUInt32BE(0);
        if (pageNumber <= committedPages) {
          readExactly(walDescriptor, page, replay + 24);
          writeExactly(databaseDescriptor, page, (pageNumber - 1) * pageSize);
        }
      }
      ftruncateSync(databaseDescriptor, checkpointBytes);
      transactionStart = position + frameSize;
    }
    fsyncSync(databaseDescriptor);
  } finally {
    closeSync(walDescriptor);
    closeSync(databaseDescriptor);
  }
  return hashFileVerified(databasePath);
}

function checkpointSourceDatabase(
  sourcePath: string,
  sourceDatabase: BackupFileMetadata,
  sourceWalPath: string,
  sourceWal: BackupFileMetadata,
  checkpointedPath: string,
  checkpointedDatabase: BackupFileMetadata,
): void {
  if (!metadataMatches(hashFileVerified(sourcePath), sourceDatabase)
    || !metadataMatches(hashFileVerified(sourceWalPath), sourceWal)) {
    throw new Error('Database changed before WAL checkpoint publication.');
  }
  const temporaryPath = `${sourcePath}.checkpoint-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  try {
    const copied = copyFileVerified(checkpointedPath, temporaryPath);
    if (!metadataMatches(copied, checkpointedDatabase)) throw new Error('Checkpoint copy verification failed.');
    renameSync(temporaryPath, sourcePath);
    syncDirectory(dirname(sourcePath));
    if (!metadataMatches(hashFileVerified(sourcePath), checkpointedDatabase)) {
      throw new Error('Checkpoint publication verification failed.');
    }
    unlinkSync(sourceWalPath);
    syncDirectory(dirname(sourcePath));
  } catch {
    rmSync(temporaryPath, { force: true });
    throw new Error('Database WAL checkpoint failed.');
  }
}

function writeMetadata(path: string, metadata: BackupMetadata): void {
  const bytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const descriptor = openSync(path, 'wx', PRIVATE_FILE_MODE);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) throw new Error('Backup storage is unavailable.');
      offset += written;
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function databaseIntegrity(path: string): 'ok' {
  const database = createDatabase(path);
  try {
    const row = database.sqlite.prepare('PRAGMA integrity_check').get();
    const result = row === undefined ? undefined : Object.values(row)[0];
    if (result !== 'ok') throw new Error('Database backup failed integrity verification.');
    return 'ok';
  } finally {
    database.close();
  }
}

function publishedName(date: Date, createId: () => string): string {
  if (Number.isNaN(date.getTime())) throw new Error('Backup clock is invalid.');
  const identifier = createId();
  if (!/^[0-9a-f]{16}$/.test(identifier)) throw new Error('Backup identifier is invalid.');
  return `${date.toISOString().replace(/[:.]/g, '-')}-${identifier}-pre-migration`;
}

function retainNewestBackups(root: string, protectedName: string): void {
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PUBLISHED_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  let excess = Math.max(0, candidates.length - RETAINED_AUTOMATIC_BACKUPS);
  for (const name of candidates) {
    if (excess === 0) break;
    if (name === protectedName) continue;
    const target = join(root, name);
    const stats = lstatSync(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    rmSync(target, { recursive: true, force: false });
    excess -= 1;
  }
  syncDirectory(root);
}

function createOwnedPreMigrationBackup(options: CreatePreMigrationBackupOptions): PreMigrationBackup {
  const root = ensureBackupRoot(options.dataDir);
  const createdAt = (options.clock ?? (() => new Date()))();
  const name = publishedName(createdAt, options.backupId ?? (() => randomBytes(8).toString('hex')));
  const temporaryPath = join(root, `.${name}.${process.pid}.tmp`);
  const finalPath = join(root, name);
  ensurePrivateDirectory(temporaryPath);
  let published = false;
  try {
    const databaseName = basename(options.databasePath);
    const sourceDatabase = copyFileVerified(options.databasePath, join(temporaryPath, databaseName));
    let database = sourceDatabase;
    let checkpoint: BackupMetadata['checkpoint'] = 'connection_closed';
    const walPath = `${options.databasePath}-wal`;
    let wal: BackupFileMetadata | undefined;
    try {
      lstatSync(walPath);
      wal = copyFileVerified(walPath, join(temporaryPath, `${databaseName}-wal`));
      database = applyCommittedWal(
        join(temporaryPath, databaseName),
        join(temporaryPath, `${databaseName}-wal`),
        wal.bytes,
      );
      checkpoint = 'wal_checkpointed';
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const metadata: BackupMetadata = {
      formatVersion: BACKUP_FORMAT_VERSION,
      kind: 'pre_migration',
      createdAt: createdAt.toISOString(),
      schemaVersion: options.schemaVersion,
      checkpoint,
      database,
      ...(wal === undefined ? {} : { wal }),
      integrityCheck: databaseIntegrity(join(temporaryPath, databaseName)),
    };
    writeMetadata(join(temporaryPath, BACKUP_METADATA_FILE), metadata);
    syncDirectory(temporaryPath);
    renameSync(temporaryPath, finalPath);
    published = true;
    syncDirectory(root);
    if (wal !== undefined) {
      checkpointSourceDatabase(
        options.databasePath,
        sourceDatabase,
        walPath,
        wal,
        join(finalPath, databaseName),
        database,
      );
    }
    retainNewestBackups(root, name);
    return { path: finalPath, metadata };
  } catch {
    if (!published) rmSync(temporaryPath, { recursive: true, force: true });
    throw new Error('Pre-migration backup failed.');
  }
}

/** Creates one exclusively owned, closed-connection, atomically published pre-migration backup. */
export function createPreMigrationBackup(options: CreatePreMigrationBackupOptions): PreMigrationBackup {
  const ownership = options.databaseOwnership
    ?? acquireDatabaseOwnership(options.databasePath);
  const temporaryOwnership = options.databaseOwnership === undefined;
  try {
    ownership.assertHeld(options.databasePath);
    const backup = createOwnedPreMigrationBackup(options);
    ownership.assertHeld(options.databasePath);
    return backup;
  } finally {
    if (temporaryOwnership) ownership.release();
  }
}
