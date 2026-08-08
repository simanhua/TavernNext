import type { TavernDatabase } from './client.js';

const migrations = `
  CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worldbooks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worldbook_entries (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS worldbook_entries_worldbook_id_idx ON worldbook_entries(worldbook_id);
  CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES characters(id), persona_id TEXT NOT NULL REFERENCES personas(id), preset_id TEXT REFERENCES presets(id), title TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS conversations_character_id_idx ON conversations(character_id);
  CREATE INDEX IF NOT EXISTS conversations_persona_id_idx ON conversations(persona_id);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
  CREATE TABLE IF NOT EXISTS message_variants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS message_variants_message_id_idx ON message_variants(message_id);
  CREATE TABLE IF NOT EXISTS provider_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS import_artifacts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT);
  CREATE TABLE IF NOT EXISTS generation_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS generation_snapshots_conversation_id_idx ON generation_snapshots(conversation_id);
`;

export function migrateDatabase(database: TavernDatabase): void {
  database.sqlite.exec(migrations);
}
