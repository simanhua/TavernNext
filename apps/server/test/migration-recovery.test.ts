import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import {
  BACKUP_METADATA_FILE,
  createPreMigrationBackup,
  type BackupMetadata,
} from '../src/services/backup-service.js';
import { SECRET_STORE_FILE } from '../src/services/secret-store.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const characterId = '018f0000-0000-7000-8000-000000001611';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-migration-recovery-'));
  directories.push(directory);
  return directory;
}

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

async function seedDatabase(directory: string) {
  const config = {
    host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'tavernnext.sqlite'),
  };
  const app = createApp({ config, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
  await app.ready();
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: {
      id: characterId,
      name: 'Recovery witness',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      alternateGreetings: [],
      tags: [],
    },
  });
  expect(created.statusCode).toBe(201);
  await app.close();
  return config;
}

async function backupDirectories(directory: string): Promise<string[]> {
  const root = join(directory, 'backups');
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(root, entry.name))
    .sort();
}

function walChecksum(bytes: Uint8Array, state: readonly [number, number]): [number, number] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [first, second] = state;
  for (let offset = 0; offset < view.byteLength; offset += 8) {
    first = (first + view.readUInt32BE(offset) + second) >>> 0;
    second = (second + view.readUInt32BE(offset + 4) + first) >>> 0;
  }
  return [first, second];
}

function committedWal(database: Uint8Array): Buffer {
  const image = Buffer.from(database);
  const encodedPageSize = image.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (image.byteLength % pageSize !== 0) throw new Error('invalid test database image');
  const pages = image.byteLength / pageSize;
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0683, 0);
  header.writeUInt32BE(3_007_000, 4);
  header.writeUInt32BE(pageSize, 8);
  header.writeUInt32BE(0, 12);
  header.writeUInt32BE(0x16161616, 16);
  header.writeUInt32BE(0x26262626, 20);
  let checksum = walChecksum(header.subarray(0, 24), [0, 0]);
  header.writeUInt32BE(checksum[0], 24);
  header.writeUInt32BE(checksum[1], 28);
  const frames: Buffer[] = [header];
  for (let page = 1; page <= pages; page += 1) {
    const frame = Buffer.alloc(24 + pageSize);
    frame.writeUInt32BE(page, 0);
    frame.writeUInt32BE(page === pages ? pages : 0, 4);
    frame.writeUInt32BE(0x16161616, 8);
    frame.writeUInt32BE(0x26262626, 12);
    image.copy(frame, 24, (page - 1) * pageSize, page * pageSize);
    checksum = walChecksum(frame.subarray(0, 8), checksum);
    checksum = walChecksum(frame.subarray(24), checksum);
    frame.writeUInt32BE(checksum[0], 16);
    frame.writeUInt32BE(checksum[1], 20);
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

describe('migration backup and recovery', () => {
  it('publishes a verified pre-migration DB/WAL/schema backup and retains only the five newest successes', async () => {
    const directory = await temporaryDirectory();
    const config = await seedDatabase(directory);
    const beforeDatabase = readFileSync(config.databasePath);
    const desiredPath = join(directory, 'wal-desired.sqlite');
    writeFileSync(desiredPath, beforeDatabase);
    const desiredDatabase = createDatabase(desiredPath);
    desiredDatabase.sqlite.exec("CREATE TABLE wal_recovery_witness (value TEXT NOT NULL); INSERT INTO wal_recovery_witness VALUES ('preserved');");
    desiredDatabase.close();
    const checkpointedDatabase = readFileSync(desiredPath);
    rmSync(desiredPath);
    const walBytes = Buffer.concat([
      committedWal(checkpointedDatabase),
      Buffer.from('recoverable-crash-partial-frame'),
    ]);
    writeFileSync(`${config.databasePath}-wal`, walBytes);

    for (let index = 0; index < 7; index += 1) {
      const instant = new Date(Date.UTC(2026, 7, 9, 12, 0, index));
      const app = createApp({
        config,
        snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
        backupClock: () => instant,
      });
      await app.ready();
      expect(app.startupMigrationResult).toBe('writable');
      await app.close();
      if (index === 0) {
        const firstBackup = (await backupDirectories(directory))[0]!;
        const firstMetadata = JSON.parse(await readFile(join(firstBackup, BACKUP_METADATA_FILE), 'utf8')) as BackupMetadata;
        expect(firstMetadata).toMatchObject({
          schemaVersion: 9,
          checkpoint: 'wal_checkpointed',
          database: {
            bytes: checkpointedDatabase.byteLength,
            sha256: createHash('sha256').update(checkpointedDatabase).digest('hex'),
          },
          wal: {
            file: `${basename(config.databasePath)}-wal`,
            bytes: walBytes.byteLength,
            sha256: createHash('sha256').update(walBytes).digest('hex'),
          },
          integrityCheck: 'ok',
        });
        expect(await readFile(join(firstBackup, basename(config.databasePath)))).toEqual(checkpointedDatabase);
        expect(existsSync(`${config.databasePath}-wal`)).toBe(false);
        const checkpointed = createDatabase(config.databasePath);
        try {
          expect(checkpointed.sqlite.prepare('SELECT value FROM wal_recovery_witness').get()).toEqual({ value: 'preserved' });
        } finally {
          checkpointed.close();
        }
      }
    }

    const backups = await backupDirectories(directory);
    expect(backups).toHaveLength(5);
    const metadata = await Promise.all(backups.map(async (path) => JSON.parse(
      await readFile(join(path, BACKUP_METADATA_FILE), 'utf8'),
    ) as BackupMetadata));
    expect(metadata.map((item) => item.createdAt)).toEqual([
      '2026-08-09T12:00:02.000Z',
      '2026-08-09T12:00:03.000Z',
      '2026-08-09T12:00:04.000Z',
      '2026-08-09T12:00:05.000Z',
      '2026-08-09T12:00:06.000Z',
    ]);
    const newestPath = backups.at(-1)!;
    const newest = metadata.at(-1)!;
    expect(newest).toMatchObject({
      formatVersion: 1,
      kind: 'pre_migration',
      schemaVersion: 9,
      database: {
        file: basename(config.databasePath),
      },
      integrityCheck: 'ok',
    });
    expect(newest.wal).toBeUndefined();
    expect(await readFile(join(newestPath, basename(config.databasePath)))).toEqual(readFileSync(config.databasePath));
    expect((await readdir(join(directory, 'backups'))).some((name) => name.startsWith('.'))).toBe(false);
  });

  it('refuses an unverifiable WAL instead of publishing false checkpoint and integrity claims', async () => {
    const directory = await temporaryDirectory();
    const config = await seedDatabase(directory);
    writeFileSync(`${config.databasePath}-wal`, 'not-a-valid-sqlite-wal');

    expect(() => createPreMigrationBackup({
      dataDir: directory,
      databasePath: config.databasePath,
      schemaVersion: 9,
      clock: () => new Date('2026-08-09T12:45:00.000Z'),
    })).toThrow('Pre-migration backup failed');
    expect(await backupDirectories(directory)).toEqual([]);
    expect((await readdir(join(directory, 'backups'))).some((name) => name.startsWith('.'))).toBe(false);
  });

  it('never prunes the just-published successful backup when timestamps collide', async () => {
    const directory = await temporaryDirectory();
    const config = await seedDatabase(directory);
    const identifiers = [
      '0000000000000006',
      '0000000000000005',
      '0000000000000004',
      '0000000000000003',
      '0000000000000002',
      '0000000000000001',
    ];
    let newestSuccessful = '';
    for (const identifier of identifiers) {
      newestSuccessful = createPreMigrationBackup({
        dataDir: directory,
        databasePath: config.databasePath,
        schemaVersion: 9,
        clock: () => new Date('2026-08-09T12:30:00.000Z'),
        backupId: () => identifier,
      }).path;
      expect(basename(newestSuccessful)).toContain(identifier);
    }

    expect(existsSync(newestSuccessful)).toBe(true);
    expect(await backupDirectories(directory)).toHaveLength(5);
  });

  it('starts in stable read-only mode after migration failure, keeps reads available, and rejects mutations before side effects', async () => {
    const directory = await temporaryDirectory();
    const config = await seedDatabase(directory);
    const migrationSecret = 'task-16-migration-error-secret';
    const submittedSecret = 'task-16-read-only-submitted-secret';
    const logs = new CaptureStream();
    const app = createApp({
      config,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      loggerStream: logs,
      backupClock: () => new Date('2026-08-09T13:00:00.000Z'),
      migrationRunner() {
        throw new Error(`injected migration failure ${migrationSecret}`);
      },
    });
    apps.push(app);
    await app.ready();

    expect(app.startupMigrationResult).toBe('read_only_migration_failed');
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: 'warning',
      app: 'TavernNext',
      mode: 'read_only_migration_failed',
      warning: { code: 'migration_failed' },
    });
    const readable = await app.inject({ method: 'GET', url: '/api/characters' });
    expect(readable.statusCode).toBe(200);
    expect(readable.json()).toEqual([expect.objectContaining({ id: characterId, name: 'Recovery witness' })]);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const rejected = await app.inject({
        method,
        url: '/api/health',
        payload: { apiKey: submittedSecret },
      });
      expect(rejected.statusCode, method).toBe(503);
      expect(rejected.json(), method).toEqual({ error: 'read_only_migration_failed' });
    }
    const providerWrite = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: '018f0000-0000-7000-8000-000000001612',
        name: 'Must not persist',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'mock',
        apiMode: 'chat',
        apiKey: submittedSecret,
      },
    });
    expect(providerWrite.statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/providers' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/characters' })).json())
      .toEqual([expect.objectContaining({ id: characterId })]);

    expect(await backupDirectories(directory)).toHaveLength(1);
    expect(await readdir(join(directory, 'tmp', 'imports'))).toEqual([]);
    expect(await readdir(join(directory, 'assets', 'imports'))).toEqual([]);
    expect(readFileSync(config.databasePath).includes(Buffer.from(submittedSecret))).toBe(false);
    const secretsPath = join(directory, SECRET_STORE_FILE);
    if (existsSync(secretsPath)) expect(readFileSync(secretsPath).includes(Buffer.from(submittedSecret))).toBe(false);
    const capturedLogs = logs.chunks.join('');
    expect(capturedLogs).not.toContain(migrationSecret);
    expect(capturedLogs).not.toContain(submittedSecret);
  });

  it('backs up malformed schema metadata and enters recovery instead of aborting before the migration guard', async () => {
    const directory = await temporaryDirectory();
    const config = await seedDatabase(directory);
    const malformed = createDatabase(config.databasePath);
    malformed.sqlite.exec('DROP TABLE tavernnext_schema_version; CREATE TABLE tavernnext_schema_version (legacy_value INTEGER NOT NULL); INSERT INTO tavernnext_schema_version VALUES (8);');
    malformed.close();

    const app = createApp({
      config,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      backupClock: () => new Date('2026-08-09T13:30:00.000Z'),
    });
    apps.push(app);
    await app.ready();

    expect(app.startupMigrationResult).toBe('read_only_migration_failed');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      status: 'warning',
      mode: 'read_only_migration_failed',
    });
    expect((await app.inject({ method: 'GET', url: '/api/characters' })).json())
      .toEqual([expect.objectContaining({ id: characterId })]);
    const [backup] = await backupDirectories(directory);
    const metadata = JSON.parse(await readFile(join(backup!, BACKUP_METADATA_FILE), 'utf8')) as BackupMetadata;
    expect(metadata.schemaVersion).toBeNull();
  });

  it('holds exclusive application ownership from startup until close', async () => {
    const directory = await temporaryDirectory();
    const config = await seedDatabase(directory);
    const first = createApp({ config, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(first);
    await first.ready();

    let second: ReturnType<typeof createApp> | undefined;
    let secondError: unknown;
    try {
      second = createApp({
        config,
        snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
        databaseOwnershipTimeoutMs: 25,
      });
    } catch (error) {
      secondError = error;
    }
    if (second !== undefined) {
      apps.push(second);
      await second.close();
    }
    expect(secondError).toBeInstanceOf(Error);
    expect((secondError as Error).message).toBe('Database is already in use.');

    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const afterClose = createApp({
      config,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      databaseOwnershipTimeoutMs: 25,
    });
    apps.push(afterClose);
    await afterClose.ready();
    expect(afterClose.startupMigrationResult).toBe('writable');
  });
});
