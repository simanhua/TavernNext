import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createRepositories } from '../../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS } from '../test-integrity-key.js';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestRepositories() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-'));
  testDirectories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  return { database, repositories: createRepositories(database, TEST_REPOSITORY_OPTIONS) };
}

function createLegacySchema(database: ReturnType<typeof createDatabase>): void {
  database.sqlite.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE personas (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE worldbooks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE worldbook_entries (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id) ON DELETE CASCADE);
    CREATE INDEX worldbook_entries_worldbook_id_idx ON worldbook_entries(worldbook_id);
    CREATE TABLE presets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES characters(id), persona_id TEXT NOT NULL REFERENCES personas(id), preset_id TEXT REFERENCES presets(id), title TEXT NOT NULL);
    CREATE INDEX conversations_character_id_idx ON conversations(character_id);
    CREATE INDEX conversations_persona_id_idx ON conversations(persona_id);
    CREATE TABLE messages (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL);
    CREATE INDEX messages_conversation_id_idx ON messages(conversation_id);
    CREATE TABLE message_variants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL);
    CREATE INDEX message_variants_message_id_idx ON message_variants(message_id);
    CREATE TABLE provider_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE import_artifacts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT);
    CREATE TABLE generation_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE);
    CREATE INDEX generation_snapshots_conversation_id_idx ON generation_snapshots(conversation_id);
  `);
}

describe('SQLite repositories', () => {
  it('creates every planned persistence table', async () => {
    const { database } = await createTestRepositories();
    const tables = database.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'characters', 'personas', 'worldbooks', 'worldbook_entries', 'presets',
      'conversations', 'messages', 'message_variants', 'provider_profiles',
      'import_artifacts', 'generation_snapshots',
      'conversation_worldbooks', 'worldbook_runtime_states', 'avatar_assets',
    ]));
  });

  it('keeps a clean database migration idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-idempotent-'));
    testDirectories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));

    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.sqlite.prepare('SELECT version FROM tavernnext_schema_version').all()).toEqual([{ version: 9 }]);
    expect(database.sqlite.prepare('PRAGMA foreign_keys').all()).toEqual([{ foreign_keys: 1 }]);
  });

  it('stores and deletes avatar bytes only through an exact entity-bound key', async () => {
    const { repositories } = await createTestRepositories();
    const path = 'assets/avatars/characters/018f0000-0000-7000-8000-000000000010/018f0000-0000-7000-8000-000000000011.png';
    const bytes = Uint8Array.from([137, 80, 78, 71]);

    repositories.avatarAssets.put({ path, kind: 'characters', ownerId: '018f0000-0000-7000-8000-000000000010', mediaType: 'image/png', bytes });
    expect(repositories.avatarAssets.getOwned(path, 'characters', '018f0000-0000-7000-8000-000000000010')).toEqual({
      path, kind: 'characters', ownerId: '018f0000-0000-7000-8000-000000000010', mediaType: 'image/png', bytes,
    });
    expect(repositories.avatarAssets.getOwned(path, 'personas', '018f0000-0000-7000-8000-000000000010')).toBeUndefined();
    expect(repositories.avatarAssets.deleteOwned(path, 'characters', '018f0000-0000-7000-8000-000000000099')).toBe(false);
    expect(repositories.avatarAssets.deleteOwned(path, 'characters', '018f0000-0000-7000-8000-000000000010')).toBe(true);
    expect(repositories.avatarAssets.getOwned(path, 'characters', '018f0000-0000-7000-8000-000000000010')).toBeUndefined();
  });

  it('preserves character compatibility metadata through a create and get cycle', async () => {
    const { database, repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000010',
      name: 'Aster',
      description: 'A careful archivist.',
      personality: '',
      scenario: '',
      firstMessage: 'Hello.',
      alternateGreetings: [],
      tags: [],
      compatibility: {
        sourceFormat: 'st-character-v3',
        rawPayload: { data: { novelField: ['kept'] } },
        unknownFields: { novelField: ['kept'] },
        compatWarnings: [],
        parserVersion: '1',
      },
    });

    expect(repositories.characters.get(character.id)?.compatibility?.rawPayload).toEqual({ data: { novelField: ['kept'] } });
  });

  it('advances a matching revision and reports a stale revision conflict', async () => {
    const { repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000011',
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });

    expect(repositories.characters.update(character.id, 0, { name: 'Aster Prime' })).toMatchObject({ ok: true, value: { revision: 1, name: 'Aster Prime' } });
    expect(repositories.characters.update(character.id, 0, { name: 'Stale write' })).toEqual({ ok: false, reason: 'conflict' });
  });

  it('persists metadata and revision across close and reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-reopen-'));
    testDirectories.push(directory);
    const path = join(directory, 'tavernnext.sqlite');
    const database = createDatabase(path);
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000012',
      name: 'Persistent', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      compatibility: {
        sourceFormat: 'st-character-v3', rawPayload: { retained: true }, unknownFields: { retained: true }, compatWarnings: [], parserVersion: '1',
      },
    });
    repositories.characters.update(character.id, 0, { name: 'Persistent Prime' });
    database.close();

    const reopened = createDatabase(path);
    migrateDatabase(reopened);
    expect(createRepositories(reopened, TEST_REPOSITORY_OPTIONS).characters.get(character.id)).toMatchObject({
      name: 'Persistent Prime', revision: 1, compatibility: { rawPayload: { retained: true } },
    });
  });

  it('flushes a committed multi-repository transaction once and rolls back failed work', async () => {
    const { database } = await createTestRepositories();

    database.transaction(() => {
      const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
      repositories.characters.create({
        id: '018f0000-0000-7000-8000-000000000013', name: 'Committed', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      });
      repositories.personas.create({
        id: '018f0000-0000-7000-8000-000000000014', name: 'Committed persona', description: '', isDefault: false,
      });
    });

    expect(() => database.transaction(() => {
      const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
      repositories.characters.create({
        id: '018f0000-0000-7000-8000-000000000015', name: 'Rolled back', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      });
      repositories.conversations.create({
        id: '018f0000-0000-7000-8000-000000000016', characterId: '018f0000-0000-7000-8000-000000000099', personaId: '018f0000-0000-7000-8000-000000000014', title: 'Invalid',
      });
    })).toThrow(/FOREIGN KEY constraint failed/);

    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    expect(repositories.characters.get('018f0000-0000-7000-8000-000000000013')).toMatchObject({ name: 'Committed' });
    expect(repositories.personas.get('018f0000-0000-7000-8000-000000000014')).toMatchObject({ name: 'Committed persona' });
    expect(repositories.characters.get('018f0000-0000-7000-8000-000000000015')).toBeUndefined();
  });

  it('does not cascade a worldbook delete to its entries', async () => {
    const { repositories } = await createTestRepositories();
    const worldbook = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000017', name: 'Lore', enabled: true,
    });
    const entry = repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000018', worldbookId: worldbook.id, keys: ['lore'], content: 'retained', enabled: true, position: 'before_character', order: 0,
    });

    expect(() => repositories.worldbooks.delete(worldbook.id, 0)).toThrow(/FOREIGN KEY constraint failed/);
    expect(repositories.worldbooks.get(worldbook.id)).toMatchObject({ id: worldbook.id });
    expect(repositories.worldbookEntries.get(entry.id)).toMatchObject({ id: entry.id });
  });

  it('lists entries by worldbook through the indexed repository method', async () => {
    const { database, repositories } = await createTestRepositories();
    const first = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000041', name: 'First lore', enabled: true,
    });
    const second = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000042', name: 'Second lore', enabled: true,
    });
    repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000043', worldbookId: first.id, keys: ['first'], content: 'first', enabled: true, position: 0, order: 0,
    });
    repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000044', worldbookId: second.id, keys: ['second'], content: 'second', enabled: true, position: 0, order: 0,
    });

    expect(repositories.worldbookEntries.listByWorldbookId(first.id)).toEqual([
      expect.objectContaining({ worldbookId: first.id, content: 'first' }),
    ]);
    const plan = database.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT payload FROM worldbook_entries WHERE worldbook_id = ?',
    ).all(first.id) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes('worldbook_entries_worldbook_id_idx'))).toBe(true);
  });

  it('uses stable indexed message, variant, and Worldbook-entry relationship reads without global scans', async () => {
    const { database, repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000061', name: 'Indexed character',
      description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000000062', name: 'Indexed persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000000063', characterId: character.id, personaId: persona.id, title: 'Indexed',
    });
    const highMessage = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000000069', conversationId: conversation.id,
      role: 'assistant', content: '', activeVariantId: null,
    });
    const lowMessage = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000000064', conversationId: conversation.id,
      role: 'user', content: 'low', activeVariantId: null,
    });
    const highVariant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000000068', messageId: highMessage.id, content: 'high', status: 'completed', ordinal: 7,
    });
    const lowVariant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000000065', messageId: highMessage.id, content: 'low', status: 'completed',
    });
    const lowMessageVariant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000000071', messageId: lowMessage.id, content: 'low-message', status: 'completed',
    });
    const book = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000066', name: 'Stable entries',
    });
    const highEntry = repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000070', worldbookId: book.id,
      keys: [], constant: true, content: 'high',
    });
    const lowEntry = repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000067', worldbookId: book.id,
      keys: [], constant: true, content: 'low',
    });
    database.sqlite.exec(`
      UPDATE messages SET created_at = '2026-08-08T00:00:00.000Z' WHERE conversation_id = '${conversation.id}';
      UPDATE message_variants SET created_at = CASE id
        WHEN '${highVariant.id}' THEN '2026-08-08T00:00:00.000Z'
        WHEN '${lowMessageVariant.id}' THEN '2026-08-08T00:00:01.000Z'
        ELSE '2026-08-08T00:00:02.000Z'
      END WHERE message_id IN ('${highMessage.id}', '${lowMessage.id}');
      UPDATE worldbook_entries SET created_at = '2026-08-08T00:00:00.000Z' WHERE worldbook_id = '${book.id}';
    `);
    migrateDatabase(database);
    expect(database.sqlite.prepare('SELECT ordinal FROM message_variants WHERE id = ?').get(highVariant.id))
      .toEqual({ ordinal: 7 });

    expect(repositories.messages.listByConversationId(conversation.id).map((row) => row.id))
      .toEqual([lowMessage.id, highMessage.id]);
    expect(repositories.messageVariants.listByMessageId(highMessage.id).map((row) => row.id))
      .toEqual([lowVariant.id, highVariant.id]);
    expect(repositories.messageVariants.listByConversationId(conversation.id).map((row) => row.id))
      .toEqual([lowMessageVariant.id, lowVariant.id, highVariant.id]);
    expect(repositories.worldbookEntries.listByWorldbookId(book.id).map((row) => row.id))
      .toEqual([lowEntry.id, highEntry.id]);

    const messagePlan = database.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT payload FROM messages WHERE conversation_id = ? ORDER BY created_at, id LIMIT 2049',
    ).all(conversation.id) as Array<{ detail: string }>;
    const variantPlan = database.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT payload FROM message_variants WHERE message_id = ? ORDER BY ordinal, created_at, id LIMIT 4097',
    ).all(highMessage.id) as Array<{ detail: string }>;
    const entryPlan = database.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT payload FROM worldbook_entries WHERE worldbook_id = ? ORDER BY created_at, id LIMIT 4097',
    ).all(book.id) as Array<{ detail: string }>;
    expect(messagePlan.some(({ detail }) => detail.includes('messages_conversation_created_id_idx'))).toBe(true);
    expect(variantPlan.some(({ detail }) => detail.includes('message_variants_message_ordinal_created_id_idx'))).toBe(true);
    expect(messagePlan.some(({ detail }) => detail.includes('USE TEMP B-TREE'))).toBe(false);
    expect(variantPlan.some(({ detail }) => detail.includes('USE TEMP B-TREE'))).toBe(false);
    expect(entryPlan.some(({ detail }) => detail.includes('worldbook_entries_worldbook_created_id_idx'))).toBe(true);
  });

  it('caps indexed relationship reads with LIMIT max+1 before allocating or parsing rows', async () => {
    const { database, repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000071', name: 'Cap character',
      description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000000072', name: 'Cap persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000000073', characterId: character.id, personaId: persona.id, title: 'Caps',
    });
    const parent = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000000074', conversationId: conversation.id,
      role: 'assistant', content: '', activeVariantId: null,
    });
    const book = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000075', name: 'Cap book',
    });
    const digits = '(VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))';
    database.sqlite.exec(`
      WITH seq(n) AS (
        SELECT a.column1 + 10*b.column1 + 100*c.column1 + 1000*d.column1
        FROM ${digits} a, ${digits} b, ${digits} c, ${digits} d LIMIT 2049
      ) INSERT INTO messages (id, revision, created_at, updated_at, payload, conversation_id, active_variant_id, role)
        SELECT printf('overflow-message-%04d', n), 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '{}', '${conversation.id}', NULL, 'user' FROM seq;
      WITH seq(n) AS (
        SELECT a.column1 + 10*b.column1 + 100*c.column1 + 1000*d.column1
        FROM ${digits} a, ${digits} b, ${digits} c, ${digits} d LIMIT 4097
      ) INSERT INTO message_variants (id, revision, created_at, updated_at, payload, message_id, status)
        SELECT printf('overflow-variant-%04d', n), 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '{}', '${parent.id}', 'completed' FROM seq;
      WITH seq(n) AS (
        SELECT a.column1 + 10*b.column1 + 100*c.column1 + 1000*d.column1
        FROM ${digits} a, ${digits} b, ${digits} c, ${digits} d LIMIT 4097
      ) INSERT INTO worldbook_entries (id, revision, created_at, updated_at, payload, worldbook_id)
        SELECT printf('overflow-entry-%04d', n), 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '{}', '${book.id}' FROM seq;
    `);

    expect(() => repositories.messages.listByConversationId(conversation.id)).toThrow('message_relation_limit');
    expect(() => repositories.messageVariants.listByMessageId(parent.id)).toThrow('variant_relation_limit');
    expect(() => repositories.messageVariants.listByConversationId(conversation.id)).toThrow('variant_relation_limit');
    expect(() => repositories.worldbookEntries.listByWorldbookId(book.id)).toThrow('worldbook_entry_relation_limit');
  });

  it('resolves global Worldbooks through the dedicated indexed repository method', async () => {
    const { database, repositories } = await createTestRepositories();
    repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000052', name: 'Global lore', isGlobal: true,
    });
    repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000053', name: 'Local lore', isGlobal: false,
    });

    expect(repositories.worldbooks.listGlobal()).toEqual([
      expect.objectContaining({ name: 'Global lore', isGlobal: true }),
    ]);
    const plan = database.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT payload FROM worldbooks WHERE is_global = 1 ORDER BY created_at, id LIMIT 65',
    ).all() as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes('worldbooks_global_created_id_idx'))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes('USE TEMP B-TREE'))).toBe(false);
  });

  it('caps global Worldbook reads with LIMIT max+1 before parsing rows', async () => {
    const { database, repositories } = await createTestRepositories();
    const digits = '(VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))';
    database.sqlite.exec(`
      WITH seq(n) AS (
        SELECT a.column1 + 10*b.column1 FROM ${digits} a, ${digits} b LIMIT 65
      ) INSERT INTO worldbooks (id, revision, created_at, updated_at, payload, name, is_global)
        SELECT printf('overflow-global-%03d', n), 0, '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:00:00.000Z', '{}', printf('overflow-%03d', n), 1 FROM seq;
    `);

    expect(() => repositories.worldbooks.listGlobal()).toThrow('global_worldbook_relation_limit');
  });

  it('continues to read legacy entries with negative depth values', async () => {
    const { repositories } = await createTestRepositories();
    const worldbook = repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000045', name: 'Legacy lore', enabled: true,
    });
    const entry = repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000046', worldbookId: worldbook.id,
      keys: ['legacy'], content: 'legacy', enabled: true, position: 0, order: 0,
      depth: -1, scanDepth: -2,
    });

    expect(repositories.worldbookEntries.get(entry.id)).toMatchObject({ depth: -1, scanDepth: -2 });
    expect(repositories.worldbookEntries.listByWorldbookId(worldbook.id)).toEqual([
      expect.objectContaining({ id: entry.id, depth: -1, scanDepth: -2 }),
    ]);
  });

  it('persists a separately revisioned Worldbook timed state and exposes snapshots as immutable', async () => {
    const { repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000047', name: 'Runtime character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000000048', name: 'Runtime persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000000049', characterId: character.id, personaId: persona.id, title: 'Runtime state',
    });
    const snapshot = repositories.generationSnapshots.create({
      id: '018f0000-0000-7000-8000-000000000050', conversationId: conversation.id, conversationRevision: 0,
      payload: { schemaVersion: 1, payloadHash: 'immutable' },
    });
    const runtime = repositories.worldbookRuntimeStates.create({
      id: '018f0000-0000-7000-8000-000000000051', conversationId: conversation.id,
      timedState: { messageIndex: null, sticky: [], cooldown: [] },
    });

    expect(repositories.generationSnapshots.get(snapshot.id)?.payload).toEqual({ schemaVersion: 1, payloadHash: 'immutable' });
    expect('update' in repositories.generationSnapshots).toBe(false);
    expect('delete' in repositories.generationSnapshots).toBe(false);
    expect(repositories.worldbookRuntimeStates.update(runtime.id, runtime.revision, {
      timedState: { messageIndex: 2, sticky: [], cooldown: [] },
    })).toMatchObject({ ok: true, value: { revision: 1, timedState: { messageIndex: 2 } } });
    expect(repositories.worldbookRuntimeStates.getByConversationId(conversation.id)).toMatchObject({
      id: runtime.id, conversationId: conversation.id, revision: 1,
    });
  });

  it('upgrades the b87d7f7 legacy schema without losing payloads or relationships', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-legacy-'));
    testDirectories.push(directory);
    const path = join(directory, 'tavernnext.sqlite');
    const database = createDatabase(path);
    createLegacySchema(database);
    const createdAt = '2026-08-08T00:00:00.000Z';
    const ids = {
      character: '018f0000-0000-7000-8000-000000000030', persona: '018f0000-0000-7000-8000-000000000031', worldbook: '018f0000-0000-7000-8000-000000000032', entry: '018f0000-0000-7000-8000-000000000033',
      conversation: '018f0000-0000-7000-8000-000000000034', message: '018f0000-0000-7000-8000-000000000035', variant: '018f0000-0000-7000-8000-000000000036',
      malformedCharacter: '018f0000-0000-7000-8000-000000000038',
    };
    const character = { id: ids.character, revision: 2, createdAt, updatedAt: createdAt, name: 'Legacy character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [], compatibility: { sourceFormat: 'st-character-v3', rawPayload: { legacy: true, extensions: { depth_prompt: { prompt: 'Migrated depth prompt' } } }, unknownFields: { legacy: true }, compatWarnings: [], parserVersion: '1' } };
    const malformedCharacter = { id: ids.malformedCharacter, revision: 0, createdAt, updatedAt: createdAt, name: 'Malformed legacy character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [], compatibility: { sourceFormat: 'st-character-v3', rawPayload: { extensions: ['malformed'] }, unknownFields: {}, compatWarnings: [], parserVersion: '1' } };
    const persona = { id: ids.persona, revision: 0, createdAt, updatedAt: createdAt, name: 'Legacy persona', description: '', isDefault: true };
    const worldbook = { id: ids.worldbook, revision: 0, createdAt, updatedAt: createdAt, name: 'Legacy lore', enabled: true };
    const entry = { id: ids.entry, revision: 0, createdAt, updatedAt: createdAt, worldbookId: ids.worldbook, keys: ['legacy'], content: 'kept', enabled: true, position: 'before_character', order: 0 };
    const conversation = { id: ids.conversation, revision: 0, createdAt, updatedAt: createdAt, characterId: ids.character, personaId: ids.persona, title: 'Legacy chat', worldbookIds: [ids.worldbook] };
    const message = { id: ids.message, revision: 0, createdAt, updatedAt: createdAt, conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: ids.variant };
    const variant = { id: ids.variant, revision: 0, createdAt, updatedAt: createdAt, messageId: ids.message, content: 'Legacy response', status: 'completed' };
    const insert = (table: string, payload: { id: string; revision: number; createdAt: string; updatedAt: string }, columns: string[], values: (string | null)[]) => {
      database.sqlite.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
    };
    insert('characters', character, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'name'], [character.id, '2', createdAt, createdAt, JSON.stringify(character), character.name]);
    insert('characters', malformedCharacter, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'name'], [malformedCharacter.id, '0', createdAt, createdAt, JSON.stringify(malformedCharacter), malformedCharacter.name]);
    insert('personas', persona, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'name'], [persona.id, '0', createdAt, createdAt, JSON.stringify(persona), persona.name]);
    insert('worldbooks', worldbook, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'name'], [worldbook.id, '0', createdAt, createdAt, JSON.stringify(worldbook), worldbook.name]);
    insert('worldbook_entries', entry, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'worldbook_id'], [entry.id, '0', createdAt, createdAt, JSON.stringify(entry), entry.worldbookId]);
    insert('conversations', conversation, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'character_id', 'persona_id', 'preset_id', 'title'], [conversation.id, '0', createdAt, createdAt, JSON.stringify(conversation), conversation.characterId, conversation.personaId, null, conversation.title]);
    insert('messages', message, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'conversation_id', 'role'], [message.id, '0', createdAt, createdAt, JSON.stringify(message), message.conversationId, message.role]);
    insert('message_variants', variant, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'message_id', 'status'], [variant.id, '0', createdAt, createdAt, JSON.stringify(variant), variant.messageId, variant.status]);

    migrateDatabase(database);
    const firstMalformedRow = database.sqlite.prepare('SELECT revision, payload FROM characters WHERE id = ?')
      .get(ids.malformedCharacter);
    migrateDatabase(database);
    migrateDatabase(database);
    const repeatedMalformedRow = database.sqlite.prepare('SELECT revision, payload FROM characters WHERE id = ?')
      .get(ids.malformedCharacter);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);

    expect(repeatedMalformedRow).toEqual(firstMalformedRow);

    expect(repositories.characters.get(ids.character)).toMatchObject({
      revision: 2,
      depthPrompt: 'Migrated depth prompt',
      compatibility: { rawPayload: { legacy: true } },
    });
    expect(repositories.characters.get(ids.malformedCharacter)).toMatchObject({
      depthPrompt: '',
      revision: 0,
      compatibility: { compatWarnings: ['character_depth_prompt_invalid'] },
    });
    expect(repositories.messages.get(ids.message)).toMatchObject({ activeVariantId: ids.variant });
    expect(database.sqlite.prepare('PRAGMA table_info(messages)').all().map((column) => column.name)).toContain('active_variant_id');
    expect(database.sqlite.prepare('PRAGMA index_list(messages)').all().map((index) => index.name)).toContain('messages_active_variant_id_idx');
    expect(database.sqlite.prepare('SELECT worldbook_id FROM conversation_worldbooks WHERE conversation_id = ?').all(ids.conversation)).toEqual([{ worldbook_id: ids.worldbook }]);
    expect(() => repositories.worldbooks.delete(ids.worldbook, 0)).toThrow(/FOREIGN KEY constraint failed/);

    const insertedMessage = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000000037', conversationId: ids.conversation, role: 'user', content: 'Current write', activeVariantId: null,
    });
    expect(insertedMessage.id).toBe('018f0000-0000-7000-8000-000000000037');
    expect(database.sqlite.prepare('SELECT active_variant_id FROM messages WHERE id = ?').get(insertedMessage.id)).toEqual({ active_variant_id: null });
    expect(database.sqlite.prepare('PRAGMA table_info(worldbooks)').all().map((column) => column.name)).toContain('is_global');
    expect(database.sqlite.prepare('PRAGMA table_info(conversations)').all().map((column) => column.name)).toEqual(expect.arrayContaining([
      'provider_id', 'context_preset_id', 'instruct_preset_id', 'system_preset_id',
    ]));
    expect(database.sqlite.prepare('PRAGMA table_info(generation_snapshots)').all().map((column) => column.name))
      .toContain('integrity_tag');
    expect(database.sqlite.prepare('PRAGMA table_info(message_variants)').all().map((column) => column.name))
      .toContain('ordinal');
    expect(repositories.worldbooks.get(ids.worldbook)).toMatchObject({ isGlobal: false });
    expect(repositories.conversations.get(ids.conversation)).toMatchObject({
      maxPromptTokens: 128_000, maxResponseTokens: 32_768,
    });
    expect(database.sqlite.prepare('SELECT version FROM tavernnext_schema_version').all()).toEqual([{ version: 9 }]);
  });

  it('cascades deleted conversations to messages and variants without deleting their character or persona', async () => {
    const { database, repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000020', name: 'Character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000000021', name: 'Persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000000022', characterId: character.id, personaId: persona.id, title: 'Test chat',
    });
    const message = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000000023', conversationId: conversation.id, role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000000024', messageId: message.id, content: 'Hello', status: 'completed',
    });

    expect(database.sqlite.prepare('PRAGMA foreign_keys').all()).toEqual([{ foreign_keys: 1 }]);
    expect(repositories.conversations.delete(conversation.id, 0)).toEqual({ ok: true });
    expect(repositories.messages.get(message.id)).toBeUndefined();
    expect(repositories.messageVariants.get(variant.id)).toBeUndefined();
    expect(repositories.characters.get(character.id)).toMatchObject({ id: character.id });
    expect(repositories.personas.get(persona.id)).toMatchObject({ id: persona.id });
  });
});
