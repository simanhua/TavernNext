import type { TavernDatabase } from './client.js';

const CURRENT_SCHEMA_VERSION = 2;

const tables = `
  CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worldbooks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worldbook_entries (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id));
  CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES characters(id), persona_id TEXT NOT NULL REFERENCES personas(id), preset_id TEXT REFERENCES presets(id), title TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversation_worldbooks (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id), PRIMARY KEY (conversation_id, worldbook_id));
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, active_variant_id TEXT REFERENCES message_variants(id), role TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS message_variants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS provider_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS import_artifacts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT);
  CREATE TABLE IF NOT EXISTS generation_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE);
`;

const indexes = `
  CREATE INDEX IF NOT EXISTS worldbook_entries_worldbook_id_idx ON worldbook_entries(worldbook_id);
  CREATE INDEX IF NOT EXISTS conversations_character_id_idx ON conversations(character_id);
  CREATE INDEX IF NOT EXISTS conversations_persona_id_idx ON conversations(persona_id);
  CREATE INDEX IF NOT EXISTS conversation_worldbooks_worldbook_id_idx ON conversation_worldbooks(worldbook_id);
  CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS messages_active_variant_id_idx ON messages(active_variant_id);
  CREATE INDEX IF NOT EXISTS message_variants_message_id_idx ON message_variants(message_id);
  CREATE INDEX IF NOT EXISTS generation_snapshots_conversation_id_idx ON generation_snapshots(conversation_id);
`;

function columnNames(database: TavernDatabase, table: string): string[] {
  return database.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name));
}

function hasCascadeWorldbookEntries(database: TavernDatabase): boolean {
  return database.sqlite.prepare('PRAGMA foreign_key_list(worldbook_entries)').all()
    .some((foreignKey) => String(foreignKey.on_delete).toUpperCase() === 'CASCADE');
}

function rebuildWorldbookEntries(database: TavernDatabase): void {
  database.sqlite.exec(`
    CREATE TABLE worldbook_entries_replacement (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id));
    INSERT INTO worldbook_entries_replacement (id, revision, created_at, updated_at, payload, worldbook_id)
      SELECT id, revision, created_at, updated_at, payload, worldbook_id FROM worldbook_entries;
    DROP TABLE worldbook_entries;
    ALTER TABLE worldbook_entries_replacement RENAME TO worldbook_entries;
  `);
}

function rebuildMessages(database: TavernDatabase): void {
  database.sqlite.exec(`
    CREATE TABLE messages_replacement (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, active_variant_id TEXT REFERENCES message_variants(id), role TEXT NOT NULL);
    INSERT INTO messages_replacement (id, revision, created_at, updated_at, payload, conversation_id, active_variant_id, role)
      SELECT id, revision, created_at, updated_at, payload, conversation_id,
        CASE WHEN json_valid(payload) THEN json_extract(payload, '$.activeVariantId') ELSE NULL END,
        role
      FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_replacement RENAME TO messages;
  `);
}

function backfillConversationWorldbooks(database: TavernDatabase): void {
  database.sqlite.exec(`
    INSERT OR IGNORE INTO conversation_worldbooks (conversation_id, worldbook_id)
      SELECT conversations.id, json_each.value
      FROM conversations, json_each(conversations.payload, '$.worldbookIds')
      WHERE json_valid(conversations.payload) AND json_each.type = 'text';
  `);
}

export function migrateDatabase(database: TavernDatabase): void {
  // SQLite requires this pragma to be changed outside a transaction. It is restored in finally,
  // while all schema/data changes and the schema-version write happen in one durable transaction.
  database.sqlite.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.sqlite.exec('CREATE TABLE IF NOT EXISTS tavernnext_schema_version (version INTEGER NOT NULL)');
      database.sqlite.exec(tables);

      if (hasCascadeWorldbookEntries(database)) rebuildWorldbookEntries(database);
      if (!columnNames(database, 'messages').includes('active_variant_id')) rebuildMessages(database);

      backfillConversationWorldbooks(database);
      database.sqlite.exec(indexes);
      database.sqlite.exec(`DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version (version) VALUES (${CURRENT_SCHEMA_VERSION});`);
    });
  } finally {
    database.sqlite.pragma('foreign_keys = ON');
  }
}
