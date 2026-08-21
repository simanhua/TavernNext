import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import {
  BACKUP_METADATA_FILE,
  createPreMigrationBackup,
  type BackupMetadata,
} from '../src/services/backup-service.js';
import { SECRET_STORE_FILE } from '../src/services/secret-store.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

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
  it('backs up schema 10, removes every Conversation-owned row, and preserves the library', async () => {
    const directory = await temporaryDirectory();
    const config = {
      host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'tavernnext.sqlite'),
    };
    const database = createDatabase(config.databasePath);
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000001701', name: 'Kept Character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      extensions: {
        regex_scripts: [{ id: 'kept-regex', scriptName: 'Kept regex', findRegex: '/x/g', replaceString: 'y' }],
        tavern_helper: [['scripts', [{
          id: 'kept-script', type: 'script', name: 'Kept script', enabled: true, content: 'return 1;',
        }]], ['variables', { kept: true }]],
      },
    });
    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000001702', name: 'Kept Persona', description: '', isDefault: true,
    });
    const provider = repositories.providerProfiles.create({
      id: '018f0000-0000-7000-8000-000000001703', name: 'Kept Provider', baseUrl: 'https://provider.example/v1', model: 'model', apiMode: 'chat',
    });
    const preset = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000001704', name: 'Kept Preset', kind: 'chat', settings: { prompts: [], prompt_order: [] },
      compatibility: {
        sourceFormat: 'preset:json',
        rawPayload: {
          rawDocument: {
            prompts: [], prompt_order: [],
            extensions: {
              regex_scripts: [{ id: 'preset-regex', scriptName: 'Preset regex', findRegex: '/x/g', replaceString: 'y' }],
              tavern_helper: [['scripts', [{
                id: 'preset-script', type: 'script', name: 'Preset script', enabled: true, content: 'return 1;',
              }]], ['variables', {}]],
            },
          },
          associationEnvelope: { type: 'tavernnext:preset-source-associations', version: 1, kind: 'chat', entries: [] },
        },
        unknownFields: {}, compatWarnings: [], parserVersion: '1',
      },
    });
    const worldbook = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000001705', name: 'Kept Worldbook', enabled: true,
    });
    repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000001706', worldbookId: worldbook.id, keys: ['kept'], content: 'Kept entry',
    });
    repositories.importArtifacts.create({
      id: '018f0000-0000-7000-8000-000000001707', kind: 'character', sourceName: 'kept.json', mediaType: 'application/json', rawArtifact: 'e30=', entityId: character.id,
    });
    expect(repositories.globalGenerationConfig.update(0, { providerId: provider.id, chatPresetId: preset.id }))
      .toMatchObject({ ok: true });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000001708', characterId: character.id, personaId: persona.id,
      title: 'Removed Conversation', worldbookIds: [worldbook.id],
    });
    const message = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000001709', conversationId: conversation.id,
      role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000001710', messageId: message.id, content: 'Removed response', status: 'completed',
    });
    expect(repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id })).toMatchObject({ ok: true });
    repositories.generationSnapshots.create({
      id: '018f0000-0000-7000-8000-000000001711', conversationId: conversation.id,
      conversationRevision: conversation.revision, payload: { schemaVersion: 1 },
    });
    repositories.worldbookRuntimeStates.create({
      id: '018f0000-0000-7000-8000-000000001712', conversationId: conversation.id,
      timedState: { messageIndex: null, sticky: [], cooldown: [] },
    });
    database.sqlite.pragma('foreign_keys = OFF');
    database.sqlite.exec(`
      INSERT INTO message_variants (id, revision, created_at, updated_at, payload, message_id, ordinal, status)
      VALUES (
        '018f0000-0000-7000-8000-000000001713', 0,
        '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z',
        '{"id":"018f0000-0000-7000-8000-000000001713"}',
        '018f0000-0000-7000-8000-000000009999', 0, 'completed'
      );
      CREATE TABLE extension_states (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner_id TEXT,
        payload TEXT NOT NULL
      );
      INSERT INTO extension_states VALUES
        ('conversation-state', 'conversation', '${conversation.id}', '{}'),
        ('message-state', 'message', '${message.id}', '{}'),
        ('variant-state', 'message-variant', '${variant.id}', '{}'),
        ('global-state', 'global', NULL, '{"kept":true}');
    `);
    database.sqlite.pragma('foreign_keys = ON');
    const conversationColumns = new Set(database.sqlite.prepare('PRAGMA table_info(conversations)').all().map((column) => String(column.name)));
    for (const column of ['provider_id', 'preset_id', 'context_preset_id', 'instruct_preset_id', 'system_preset_id']) {
      if (!conversationColumns.has(column)) database.sqlite.exec(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`);
    }
    database.sqlite.exec(`
      UPDATE conversations SET provider_id = '${provider.id}', preset_id = '${preset.id}';
      UPDATE presets SET payload = json_remove(payload, '$.extensions') WHERE id = '${preset.id}';
      UPDATE tavernnext_schema_version SET version = 10;
    `);
    database.close();

    const app = createApp({
      config,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      backupClock: () => new Date('2026-08-22T00:00:00.000Z'),
    });
    apps.push(app);
    await app.ready();

    expect(app.startupMigrationResult).toBe('writable');
    expect((await app.inject({ method: 'GET', url: '/api/conversations' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/characters' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/providers' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/presets' })).json()).toHaveLength(1);
    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health).toMatchObject({ status: 'ok', backup: { kind: 'pre_migration', path: expect.any(String) } });
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    const backups = await backupDirectories(directory);
    expect(backups).toHaveLength(1);
    expect(health.backup.path).toBe(backups[0]);
    const metadata = JSON.parse(await readFile(join(backups[0]!, BACKUP_METADATA_FILE), 'utf8')) as BackupMetadata;
    expect(metadata).toMatchObject({ schemaVersion: 10, integrityCheck: 'ok' });
    const backupDatabase = createDatabase(join(backups[0]!, basename(config.databasePath)));
    expect(backupDatabase.sqlite.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 1 });
    expect(backupDatabase.sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
    backupDatabase.close();

    const migrated = createDatabase(config.databasePath);
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM message_variants').get()).toEqual({ count: 0 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM generation_snapshots').get()).toEqual({ count: 0 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM worldbook_runtime_states').get()).toEqual({ count: 0 });
    expect(migrated.sqlite.prepare('SELECT id, scope FROM extension_states ORDER BY id').all()).toEqual([
      { id: 'global-state', scope: 'global' },
    ]);
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM personas').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM provider_profiles').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM presets').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM worldbooks').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM worldbook_entries').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM import_artifacts').get()).toEqual({ count: 1 });
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM extension_assets').get()).toEqual({ count: 4 });
    const migratedCharacter = JSON.parse(String(
      migrated.sqlite.prepare('SELECT payload FROM characters WHERE id = ?').get(character.id)!.payload,
    )) as Record<string, unknown>;
    expect(Array.isArray((migratedCharacter.extensions as Record<string, unknown>).tavern_helper)).toBe(false);
    const migratedPreset = JSON.parse(String(
      migrated.sqlite.prepare('SELECT payload FROM presets WHERE id = ?').get(preset.id)!.payload,
    )) as Record<string, unknown>;
    expect(Array.isArray((migratedPreset.extensions as Record<string, unknown>).tavern_helper)).toBe(false);
    expect(migrated.sqlite.prepare('PRAGMA table_info(conversations)').all().map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['provider_id', 'preset_id', 'context_preset_id', 'instruct_preset_id', 'system_preset_id']),
    );
    migrated.close();
  });

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
          schemaVersion: 13,
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
      schemaVersion: 13,
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
      backup: { kind: 'pre_migration', path: expect.any(String) },
      warning: { code: 'migration_failed' },
    });
    expect(health.json().backup.path).toBe((await backupDirectories(directory))[0]);
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

  it('keeps the verified backup and rolls back schema 11 when Character resources exceed the owner limit', async () => {
    const directory = await temporaryDirectory();
    const config = {
      host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'tavernnext.sqlite'),
    };
    const database = createDatabase(config.databasePath);
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000001799',
      name: 'Oversized attached resources', description: '', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [],
      extensions: {
        regex_scripts: Array.from({ length: 2_049 }, (_, ordinal) => ({
          id: `oversized-${ordinal}`, scriptName: `Oversized ${ordinal}`,
          findRegex: '/x/g', replaceString: 'y',
        })),
      },
    });
    database.sqlite.exec('DELETE FROM extension_assets; UPDATE tavernnext_schema_version SET version = 11;');
    database.close();

    const app = createApp({
      config,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      backupClock: () => new Date('2026-08-22T00:30:00.000Z'),
    });
    apps.push(app);
    await app.ready();

    expect(app.startupMigrationResult).toBe('read_only_migration_failed');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      status: 'warning',
      backup: { kind: 'pre_migration', path: expect.any(String) },
    });
    expect(await backupDirectories(directory)).toHaveLength(1);
    await app.close();
    apps.splice(apps.indexOf(app), 1);

    const rolledBack = createDatabase(config.databasePath);
    expect(rolledBack.sqlite.prepare('SELECT version FROM tavernnext_schema_version').get()).toEqual({ version: 11 });
    expect(rolledBack.sqlite.prepare('SELECT COUNT(*) AS count FROM extension_assets').get()).toEqual({ count: 0 });
    expect(rolledBack.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get()).toEqual({ count: 1 });
    rolledBack.close();
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
