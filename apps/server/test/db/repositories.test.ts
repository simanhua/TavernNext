import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createRepositories } from '../../src/db/repositories.js';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestRepositories() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-'));
  testDirectories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  return { database, repositories: createRepositories(database) };
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
      'conversation_worldbooks',
    ]));
  });

  it('keeps a clean database migration idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-idempotent-'));
    testDirectories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));

    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.sqlite.prepare('SELECT version FROM tavernnext_schema_version').all()).toEqual([{ version: 2 }]);
    expect(database.sqlite.prepare('PRAGMA foreign_keys').all()).toEqual([{ foreign_keys: 1 }]);
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
    const repositories = createRepositories(database);
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
    expect(createRepositories(reopened).characters.get(character.id)).toMatchObject({
      name: 'Persistent Prime', revision: 1, compatibility: { rawPayload: { retained: true } },
    });
  });

  it('flushes a committed multi-repository transaction once and rolls back failed work', async () => {
    const { database } = await createTestRepositories();

    database.transaction(() => {
      const repositories = createRepositories(database);
      repositories.characters.create({
        id: '018f0000-0000-7000-8000-000000000013', name: 'Committed', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      });
      repositories.personas.create({
        id: '018f0000-0000-7000-8000-000000000014', name: 'Committed persona', description: '', isDefault: false,
      });
    });

    expect(() => database.transaction(() => {
      const repositories = createRepositories(database);
      repositories.characters.create({
        id: '018f0000-0000-7000-8000-000000000015', name: 'Rolled back', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      });
      repositories.conversations.create({
        id: '018f0000-0000-7000-8000-000000000016', characterId: '018f0000-0000-7000-8000-000000000099', personaId: '018f0000-0000-7000-8000-000000000014', title: 'Invalid',
      });
    })).toThrow(/FOREIGN KEY constraint failed/);

    const repositories = createRepositories(database);
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
    };
    const character = { id: ids.character, revision: 2, createdAt, updatedAt: createdAt, name: 'Legacy character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [], compatibility: { sourceFormat: 'st-character-v3', rawPayload: { legacy: true }, unknownFields: { legacy: true }, compatWarnings: [], parserVersion: '1' } };
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
    insert('personas', persona, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'name'], [persona.id, '0', createdAt, createdAt, JSON.stringify(persona), persona.name]);
    insert('worldbooks', worldbook, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'name'], [worldbook.id, '0', createdAt, createdAt, JSON.stringify(worldbook), worldbook.name]);
    insert('worldbook_entries', entry, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'worldbook_id'], [entry.id, '0', createdAt, createdAt, JSON.stringify(entry), entry.worldbookId]);
    insert('conversations', conversation, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'character_id', 'persona_id', 'preset_id', 'title'], [conversation.id, '0', createdAt, createdAt, JSON.stringify(conversation), conversation.characterId, conversation.personaId, null, conversation.title]);
    insert('messages', message, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'conversation_id', 'role'], [message.id, '0', createdAt, createdAt, JSON.stringify(message), message.conversationId, message.role]);
    insert('message_variants', variant, ['id', 'revision', 'created_at', 'updated_at', 'payload', 'message_id', 'status'], [variant.id, '0', createdAt, createdAt, JSON.stringify(variant), variant.messageId, variant.status]);

    migrateDatabase(database);
    migrateDatabase(database);
    const repositories = createRepositories(database);

    expect(repositories.characters.get(ids.character)).toMatchObject({ revision: 2, compatibility: { rawPayload: { legacy: true } } });
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
    expect(database.sqlite.prepare('SELECT version FROM tavernnext_schema_version').all()).toEqual([{ version: 2 }]);
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
