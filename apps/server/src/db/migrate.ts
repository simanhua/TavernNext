import type { TavernDatabase } from './client.js';
import { GLOBAL_GENERATION_CONFIG_ID } from '@tavernnext/domain';

export const CURRENT_SCHEMA_VERSION = 10;

export function readSchemaVersion(database: TavernDatabase): number | null {
  try {
    const table = database.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tavernnext_schema_version'",
    ).get();
    if (table === undefined) return null;
    const row = database.sqlite.prepare('SELECT version FROM tavernnext_schema_version LIMIT 1').get();
    if (row === undefined || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 0) {
      return null;
    }
    return row.version;
  } catch {
    // Unknown or malformed legacy metadata must not bypass backup and the
    // guarded migration path. The migration itself remains authoritative.
    return null;
  }
}

const tables = `
  CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worldbooks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL, is_global INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS worldbook_entries (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id));
  CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES characters(id), persona_id TEXT NOT NULL REFERENCES personas(id), provider_id TEXT REFERENCES provider_profiles(id), preset_id TEXT REFERENCES presets(id), context_preset_id TEXT REFERENCES presets(id), instruct_preset_id TEXT REFERENCES presets(id), system_preset_id TEXT REFERENCES presets(id), title TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversation_worldbooks (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id), PRIMARY KEY (conversation_id, worldbook_id));
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, active_variant_id TEXT REFERENCES message_variants(id), role TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS message_variants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS provider_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS global_generation_config (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS import_artifacts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT);
  CREATE TABLE IF NOT EXISTS generation_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, integrity_tag TEXT);
  CREATE TABLE IF NOT EXISTS worldbook_runtime_states (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS avatar_assets (path TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('characters', 'personas')), owner_id TEXT NOT NULL, media_type TEXT NOT NULL, bytes BLOB NOT NULL);
`;

const indexes = `
  CREATE INDEX IF NOT EXISTS worldbooks_is_global_idx ON worldbooks(is_global);
  CREATE INDEX IF NOT EXISTS worldbooks_global_created_id_idx ON worldbooks(is_global, created_at, id);
  CREATE INDEX IF NOT EXISTS worldbook_entries_worldbook_created_id_idx ON worldbook_entries(worldbook_id, created_at, id);
  CREATE INDEX IF NOT EXISTS worldbook_entries_worldbook_id_idx ON worldbook_entries(worldbook_id);
  CREATE INDEX IF NOT EXISTS conversations_character_id_idx ON conversations(character_id);
  CREATE INDEX IF NOT EXISTS conversations_persona_id_idx ON conversations(persona_id);
  CREATE INDEX IF NOT EXISTS conversations_provider_id_idx ON conversations(provider_id);
  CREATE INDEX IF NOT EXISTS conversation_worldbooks_worldbook_id_idx ON conversation_worldbooks(worldbook_id);
  CREATE INDEX IF NOT EXISTS messages_conversation_created_id_idx ON messages(conversation_id, created_at, id);
  CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS messages_active_variant_id_idx ON messages(active_variant_id);
  CREATE INDEX IF NOT EXISTS message_variants_message_created_id_idx ON message_variants(message_id, created_at, id);
  CREATE INDEX IF NOT EXISTS message_variants_message_ordinal_created_id_idx ON message_variants(message_id, ordinal, created_at, id);
  CREATE INDEX IF NOT EXISTS message_variants_message_id_idx ON message_variants(message_id);
  CREATE INDEX IF NOT EXISTS generation_snapshots_conversation_id_idx ON generation_snapshots(conversation_id);
  CREATE INDEX IF NOT EXISTS worldbook_runtime_states_conversation_id_idx ON worldbook_runtime_states(conversation_id);
  CREATE INDEX IF NOT EXISTS avatar_assets_owner_idx ON avatar_assets(kind, owner_id);
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

function addColumn(database: TavernDatabase, table: string, name: string, definition: string): void {
  if (!columnNames(database, table).includes(name)) {
    database.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function addPromptSnapshotColumns(database: TavernDatabase): void {
  addColumn(database, 'worldbooks', 'is_global', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(database, 'conversations', 'provider_id', 'TEXT REFERENCES provider_profiles(id)');
  addColumn(database, 'conversations', 'context_preset_id', 'TEXT REFERENCES presets(id)');
  addColumn(database, 'conversations', 'instruct_preset_id', 'TEXT REFERENCES presets(id)');
  addColumn(database, 'conversations', 'system_preset_id', 'TEXT REFERENCES presets(id)');
  addColumn(database, 'generation_snapshots', 'integrity_tag', 'TEXT');
  database.sqlite.exec(`
    UPDATE worldbooks SET is_global = CASE
      WHEN json_valid(payload) AND json_extract(payload, '$.isGlobal') = 1 THEN 1 ELSE 0 END;
    UPDATE conversations SET
      provider_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.providerId') ELSE NULL END,
      context_preset_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.contextPresetId') ELSE NULL END,
      instruct_preset_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.instructPresetId') ELSE NULL END,
      system_preset_id = CASE WHEN json_valid(payload) THEN json_extract(payload, '$.systemPresetId') ELSE NULL END;
  `);
}

function addVariantColumns(database: TavernDatabase): void {
  const hadOrdinal = columnNames(database, 'message_variants').includes('ordinal');
  addColumn(database, 'message_variants', 'ordinal', 'INTEGER NOT NULL DEFAULT 0');
  if (!hadOrdinal) {
    database.sqlite.exec(`
      UPDATE message_variants
      SET ordinal = CASE
        WHEN json_valid(payload)
          AND json_type(payload, '$.ordinal') = 'integer'
          AND json_extract(payload, '$.ordinal') >= 0
          THEN json_extract(payload, '$.ordinal')
        ELSE (
          SELECT COUNT(*)
          FROM message_variants AS earlier
          WHERE earlier.message_id = message_variants.message_id
            AND (earlier.created_at < message_variants.created_at
              OR (earlier.created_at = message_variants.created_at AND earlier.id < message_variants.id))
        )
      END;
    `);
  }
  database.sqlite.exec(`
    UPDATE message_variants
    SET payload = json_set(payload, '$.ordinal', ordinal)
    WHERE json_valid(payload) AND json_type(payload, '$.ordinal') IS NULL;
    UPDATE message_variants
    SET payload = json_set(payload, '$.continuationBoundaries', json('[]'))
    WHERE json_valid(payload) AND json_type(payload, '$.continuationBoundaries') IS NULL;
  `);
}

function backfillCharacterDepthPrompt(database: TavernDatabase): void {
  database.sqlite.exec(`
    UPDATE characters
    SET payload = json_set(
      payload,
      '$.depthPrompt',
      CASE
        WHEN json_type(payload, '$.extensions') = 'object'
          AND json_type(payload, '$.extensions.depth_prompt') = 'object'
          AND json_type(payload, '$.extensions.depth_prompt.prompt') = 'text'
          THEN json_extract(payload, '$.extensions.depth_prompt.prompt')
        WHEN json_type(payload, '$.compatibility.rawPayload.extensions') = 'object'
          AND json_type(payload, '$.compatibility.rawPayload.extensions.depth_prompt') = 'object'
          AND json_type(payload, '$.compatibility.rawPayload.extensions.depth_prompt.prompt') = 'text'
          THEN json_extract(payload, '$.compatibility.rawPayload.extensions.depth_prompt.prompt')
        ELSE ''
      END
    )
    WHERE json_valid(payload) AND json_type(payload, '$.depthPrompt') IS NULL;

    UPDATE characters
    SET payload = json_set(
      payload,
      '$.compatibility.compatWarnings',
      json_insert(
        CASE
          WHEN json_type(payload, '$.compatibility.compatWarnings') = 'array'
            THEN json_extract(payload, '$.compatibility.compatWarnings')
          ELSE json('[]')
        END,
        '$[#]',
        'character_depth_prompt_invalid'
      )
    )
    WHERE json_valid(payload)
      AND json_type(payload, '$.compatibility') = 'object'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          CASE
            WHEN json_type(payload, '$.compatibility.compatWarnings') = 'array'
              THEN json_extract(payload, '$.compatibility.compatWarnings')
            ELSE json('[]')
          END
        )
        WHERE json_each.value = 'character_depth_prompt_invalid'
      )
      AND (
        (json_type(payload, '$.extensions') IS NOT NULL
          AND (
            json_type(payload, '$.extensions') <> 'object'
            OR (json_type(payload, '$.extensions.depth_prompt') IS NOT NULL
              AND (
                json_type(payload, '$.extensions.depth_prompt') <> 'object'
                OR (json_type(payload, '$.extensions.depth_prompt.prompt') IS NOT NULL
                  AND json_type(payload, '$.extensions.depth_prompt.prompt') <> 'text')
              ))
          ))
        OR (json_type(payload, '$.extensions') IS NULL
          AND json_type(payload, '$.compatibility.rawPayload.extensions') IS NOT NULL
          AND (
            json_type(payload, '$.compatibility.rawPayload.extensions') <> 'object'
            OR (json_type(payload, '$.compatibility.rawPayload.extensions.depth_prompt') IS NOT NULL
              AND (
                json_type(payload, '$.compatibility.rawPayload.extensions.depth_prompt') <> 'object'
                OR (json_type(payload, '$.compatibility.rawPayload.extensions.depth_prompt.prompt') IS NOT NULL
                  AND json_type(payload, '$.compatibility.rawPayload.extensions.depth_prompt.prompt') <> 'text')
              ))
          ))
      );

    UPDATE characters
    SET payload = json_set(payload, '$.extensions', json('{}'))
    WHERE json_valid(payload)
      AND json_type(payload, '$.extensions') IS NOT NULL
      AND json_type(payload, '$.extensions') <> 'object';
  `);
}

function seedGlobalGenerationConfig(database: TavernDatabase): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({
    id: GLOBAL_GENERATION_CONFIG_ID,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    providerId: null,
    chatPresetId: null,
    textPresetId: null,
    contextPresetId: null,
    instructPresetId: null,
    systemPresetId: null,
    selectionNotice: null,
  });
  database.sqlite.prepare(`
    INSERT OR IGNORE INTO global_generation_config (id, revision, created_at, updated_at, payload)
    VALUES (?, 0, ?, ?, ?)
  `).run(GLOBAL_GENERATION_CONFIG_ID, now, now, payload);
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

      addPromptSnapshotColumns(database);
      addVariantColumns(database);
      backfillCharacterDepthPrompt(database);
      backfillConversationWorldbooks(database);
      seedGlobalGenerationConfig(database);
      database.sqlite.exec(indexes);
      database.sqlite.exec(`DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version (version) VALUES (${CURRENT_SCHEMA_VERSION});`);
    });
  } finally {
    database.sqlite.pragma('foreign_keys = ON');
  }
}
