import { randomUUID } from 'node:crypto';
import { GLOBAL_GENERATION_CONFIG_ID } from '@tavernnext/domain';
import { attachedVariableValue, normalizeAttachedExtensions } from '@tavernnext/st-compat';
import type { TavernDatabase } from './client.js';
import { assertExtensionAssetLimit } from '../extension-assets.js';
import { assertRuntimeStateValue, parseScriptStateScopeId } from '../runtime-state-validation.js';

export const CURRENT_SCHEMA_VERSION = 18;

const conversationTableColumns = `(
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  scene_id TEXT REFERENCES installed_scenes(id) ON DELETE CASCADE,
  title TEXT NOT NULL
)`;

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
  CREATE TABLE IF NOT EXISTS conversations ${conversationTableColumns};
  CREATE TABLE IF NOT EXISTS conversation_worldbooks (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, worldbook_id TEXT NOT NULL REFERENCES worldbooks(id), PRIMARY KEY (conversation_id, worldbook_id));
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, active_variant_id TEXT REFERENCES message_variants(id), role TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS message_variants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS provider_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS global_generation_config (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS installed_scenes (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, version TEXT NOT NULL, archive_digest TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS extension_assets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL, source_key TEXT NOT NULL, ordinal INTEGER NOT NULL, enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS extension_states (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, UNIQUE (scope, scope_id));
  CREATE TABLE IF NOT EXISTS extension_trust_grants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, UNIQUE (owner_kind, owner_id));
  CREATE TABLE IF NOT EXISTS extension_remote_resources (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, url TEXT NOT NULL, sha256 TEXT NOT NULL, UNIQUE (owner_kind, owner_id, url));
  CREATE TABLE IF NOT EXISTS extension_audit_events (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, event TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS import_artifacts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT);
  CREATE TABLE IF NOT EXISTS generation_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, integrity_tag TEXT);
  CREATE TABLE IF NOT EXISTS consumed_generation_snapshots (snapshot_id TEXT PRIMARY KEY REFERENCES generation_snapshots(id) ON DELETE CASCADE, consumed_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worldbook_runtime_states (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS conversation_scene_states (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS scene_state_transitions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, parent_transition_id TEXT, source_kind TEXT NOT NULL, source_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS avatar_assets (path TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('characters', 'personas')), owner_id TEXT NOT NULL, media_type TEXT NOT NULL, bytes BLOB NOT NULL);
`;

const indexes = `
  CREATE INDEX IF NOT EXISTS worldbooks_is_global_idx ON worldbooks(is_global);
  CREATE INDEX IF NOT EXISTS worldbooks_global_created_id_idx ON worldbooks(is_global, created_at, id);
  CREATE INDEX IF NOT EXISTS worldbook_entries_worldbook_created_id_idx ON worldbook_entries(worldbook_id, created_at, id);
  CREATE INDEX IF NOT EXISTS worldbook_entries_worldbook_id_idx ON worldbook_entries(worldbook_id);
  CREATE INDEX IF NOT EXISTS conversations_character_id_idx ON conversations(character_id);
  CREATE INDEX IF NOT EXISTS conversations_persona_id_idx ON conversations(persona_id);
  CREATE INDEX IF NOT EXISTS conversations_scene_id_idx ON conversations(scene_id);
  CREATE INDEX IF NOT EXISTS installed_scenes_slug_idx ON installed_scenes(slug);
  CREATE INDEX IF NOT EXISTS conversation_scene_states_conversation_id_idx ON conversation_scene_states(conversation_id);
  CREATE INDEX IF NOT EXISTS scene_state_transitions_conversation_idx ON scene_state_transitions(conversation_id);
  CREATE INDEX IF NOT EXISTS scene_state_transitions_source_idx ON scene_state_transitions(source_kind, source_id);
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
  CREATE INDEX IF NOT EXISTS extension_assets_owner_kind_id_idx ON extension_assets(owner_kind, owner_id);
  CREATE INDEX IF NOT EXISTS extension_assets_owner_kind_id_kind_ordinal_idx ON extension_assets(owner_kind, owner_id, kind, ordinal);
  CREATE INDEX IF NOT EXISTS extension_states_scope_id_idx ON extension_states(scope, scope_id);
  CREATE INDEX IF NOT EXISTS extension_trust_grants_owner_idx ON extension_trust_grants(owner_kind, owner_id);
  CREATE INDEX IF NOT EXISTS extension_remote_resources_owner_idx ON extension_remote_resources(owner_kind, owner_id);
  CREATE INDEX IF NOT EXISTS extension_audit_events_owner_idx ON extension_audit_events(owner_kind, owner_id);
`;

function columnNames(database: TavernDatabase, table: string): string[] {
  return database.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name));
}

function tableExists(database: TavernDatabase, table: string): boolean {
  return database.sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table) !== undefined;
}

function normalizeExtensionStatesTable(database: TavernDatabase): void {
  if (!tableExists(database, 'extension_states')) return;
  const columns = new Set(columnNames(database, 'extension_states'));
  if (['revision', 'created_at', 'updated_at', 'scope_id'].every((column) => columns.has(column))) return;
  database.sqlite.exec(`
    DROP INDEX IF EXISTS extension_states_scope_id_idx;
    ALTER TABLE extension_states RENAME TO extension_states_legacy;
    CREATE TABLE extension_states (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      payload TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, UNIQUE (scope, scope_id)
    );
  `);
  const now = new Date().toISOString();
  for (const row of database.sqlite.prepare('SELECT * FROM extension_states_legacy').all()) {
    const scope = typeof row.scope === 'string' ? row.scope : '';
    if (!['global', 'character', 'preset', 'script'].includes(scope)) continue;
    const scopeId = scope === 'global'
      ? 'global'
      : typeof row.scope_id === 'string' ? row.scope_id
        : typeof row.owner_id === 'string' ? row.owner_id : '';
    if (scopeId === '' || (scope === 'script' && parseScriptStateScopeId(scopeId) === undefined)) continue;
    const decoded = parsedEntityPayload(row.payload);
    const value = decoded !== undefined && typeof decoded.value === 'object' && decoded.value !== null && !Array.isArray(decoded.value)
      ? decoded.value as Record<string, unknown>
      : decoded ?? {};
    assertRuntimeStateValue(value);
    const id = typeof row.id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)
      ? row.id
      : randomUUID();
    const revision = typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0;
    const createdAt = typeof row.created_at === 'string' ? row.created_at : now;
    const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : now;
    const payload = { id, revision, createdAt, updatedAt, scope, scopeId, value };
    database.sqlite.prepare(`
      INSERT OR REPLACE INTO extension_states (id, revision, created_at, updated_at, payload, scope, scope_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, revision, createdAt, updatedAt, JSON.stringify(payload), scope, scopeId);
  }
  database.sqlite.exec('DROP TABLE extension_states_legacy');
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
  addColumn(database, 'generation_snapshots', 'integrity_tag', 'TEXT');
  database.sqlite.exec(`
    UPDATE worldbooks SET is_global = CASE
      WHEN json_valid(payload) AND json_extract(payload, '$.isGlobal') = 1 THEN 1 ELSE 0 END;
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

function addSceneColumns(database: TavernDatabase): void {
  addColumn(database, 'conversations', 'scene_id', 'TEXT REFERENCES installed_scenes(id) ON DELETE CASCADE');
}

function clearLegacyPublicAssets(database: TavernDatabase): void {
  resetConversationExtensionStates(database);
  database.sqlite.exec(`
    DELETE FROM consumed_generation_snapshots;
    DELETE FROM message_variants;
    DELETE FROM generation_snapshots;
    DELETE FROM worldbook_runtime_states;
    DELETE FROM messages;
    DELETE FROM conversation_worldbooks;
    DELETE FROM conversations;
    DELETE FROM conversation_scene_states;
    DELETE FROM extension_audit_events;
    DELETE FROM extension_remote_resources;
    DELETE FROM extension_trust_grants;
    DELETE FROM extension_states;
    DELETE FROM extension_assets;
    DELETE FROM import_artifacts;
    DELETE FROM worldbook_entries;
    DELETE FROM worldbooks;
    DELETE FROM presets;
    DELETE FROM avatar_assets WHERE kind = 'characters';
    DELETE FROM characters;
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

function hasConversationGenerationBindings(database: TavernDatabase): boolean {
  const columns = columnNames(database, 'conversations');
  return ['provider_id', 'preset_id', 'context_preset_id', 'instruct_preset_id', 'system_preset_id']
    .some((column) => columns.includes(column));
}

function resetConversationExtensionStates(database: TavernDatabase): void {
  if (!tableExists(database, 'extension_states')) return;
  const columns = new Set(columnNames(database, 'extension_states'));
  const scopeColumn = ['scope', 'scope_type', 'scope_kind'].find((column) => columns.has(column));
  if (scopeColumn !== undefined) {
    database.sqlite.prepare(`
      DELETE FROM extension_states
      WHERE ${scopeColumn} IN ('conversation', 'message', 'message-variant', 'message_variant', 'messageVariant')
    `).run();
    return;
  }

  const ownerColumns = ['conversation_id', 'message_id', 'message_variant_id']
    .filter((column) => columns.has(column));
  if (ownerColumns.length > 0) {
    database.sqlite.exec(`DELETE FROM extension_states WHERE ${ownerColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')}`);
  }
}

function resetConversationGraph(database: TavernDatabase): void {
  resetConversationExtensionStates(database);
  database.sqlite.exec(`
    DELETE FROM message_variants;
    DELETE FROM generation_snapshots;
    DELETE FROM worldbook_runtime_states;
    DELETE FROM messages;
    DELETE FROM conversation_worldbooks;
    DELETE FROM conversations;
    DROP TABLE conversations;
    CREATE TABLE conversations ${conversationTableColumns};
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

function insertExtensionAssets(
  database: TavernDatabase,
  ownerKind: 'character' | 'preset',
  ownerId: string,
  assets: ReturnType<typeof normalizeAttachedExtensions>['assets'],
  now: string,
): void {
  assertExtensionAssetLimit(assets.length);
  for (const asset of assets) {
    const id = randomUUID();
    const payload = {
      id,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      ownerKind,
      ownerId,
      kind: asset.kind,
      sourceKey: asset.sourceKey,
      ordinal: asset.ordinal,
      enabled: asset.enabled,
      payload: asset.payload,
      diagnostics: asset.diagnostics,
    };
    database.sqlite.prepare(`
      INSERT INTO extension_assets (
        id, revision, created_at, updated_at, payload,
        owner_kind, owner_id, kind, source_key, ordinal, enabled
      ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, now, now, JSON.stringify(payload), ownerKind, ownerId,
      asset.kind, asset.sourceKey, asset.ordinal, asset.enabled ? 1 : 0,
    );
  }
}

function parsedEntityPayload(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'string') return undefined;
  try {
    const value = JSON.parse(payload) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function backfillCharacterExtensionAssets(database: TavernDatabase): void {
  const rows = database.sqlite.prepare('SELECT id, payload FROM characters').all();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    const value = parsedEntityPayload(row.payload);
    if (value === undefined) continue;
    const attached = normalizeAttachedExtensions(value.extensions);
    database.sqlite.prepare('UPDATE characters SET payload = ? WHERE id = ?')
      .run(JSON.stringify({ ...value, extensions: attached.extensions }), row.id);
    insertExtensionAssets(database, 'character', row.id, attached.assets, now);
  }
}

function presetSourceExtensions(value: Record<string, unknown>): unknown {
  if (value.extensions !== undefined) return value.extensions;
  const compatibility = typeof value.compatibility === 'object' && value.compatibility !== null
    ? value.compatibility as Record<string, unknown>
    : undefined;
  const stored = typeof compatibility?.rawPayload === 'object' && compatibility.rawPayload !== null
    ? compatibility.rawPayload as Record<string, unknown>
    : undefined;
  const raw = typeof stored?.rawDocument === 'object' && stored.rawDocument !== null
    ? stored.rawDocument as Record<string, unknown>
    : undefined;
  if (raw === undefined) return undefined;
  const wrapper = stored?.wrapperKey === 'preset' || stored?.wrapperKey === 'settings'
    ? stored.wrapperKey
    : undefined;
  const body = wrapper === undefined ? raw : raw[wrapper];
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).extensions
    : undefined;
}

function backfillPresetExtensionAssets(database: TavernDatabase): void {
  const rows = database.sqlite.prepare('SELECT id, payload FROM presets').all();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    const value = parsedEntityPayload(row.payload);
    if (value === undefined) continue;
    const attached = normalizeAttachedExtensions(presetSourceExtensions(value));
    database.sqlite.prepare('UPDATE presets SET payload = ? WHERE id = ?')
      .run(JSON.stringify({ ...value, extensions: attached.extensions }), row.id);
    insertExtensionAssets(database, 'preset', row.id, attached.assets, now);
  }
}

function backfillOwnerExtensionStates(database: TavernDatabase): void {
  const now = new Date().toISOString();
  for (const [table, scope] of [['characters', 'character'], ['presets', 'preset']] as const) {
    for (const row of database.sqlite.prepare(`SELECT id, payload FROM ${table}`).all()) {
      if (typeof row.id !== 'string') continue;
      const value = parsedEntityPayload(row.payload);
      if (value === undefined) continue;
      const variables = attachedVariableValue(value.extensions);
      if (variables === undefined) continue;
      assertRuntimeStateValue(variables);
      const id = randomUUID();
      const payload = {
        id, revision: 0, createdAt: now, updatedAt: now,
        scope, scopeId: row.id, value: variables,
      };
      database.sqlite.prepare(`
        INSERT OR IGNORE INTO extension_states (
          id, revision, created_at, updated_at, payload, scope, scope_id
        ) VALUES (?, 0, ?, ?, ?, ?, ?)
      `).run(id, now, now, JSON.stringify(payload), scope, row.id);
    }
  }
}

function backfillSceneStateKernel(database: TavernDatabase): void {
  for (const row of database.sqlite.prepare('SELECT id, payload FROM conversation_scene_states').all()) {
    if (typeof row.id !== 'string') continue;
    const value = parsedEntityPayload(row.payload);
    if (value === undefined) continue;
    const current = typeof value.value === 'object' && value.value !== null && !Array.isArray(value.value)
      ? value.value as Record<string, unknown>
      : {};
    database.sqlite.prepare('UPDATE conversation_scene_states SET payload = ? WHERE id = ?').run(JSON.stringify({
      ...value,
      baseValue: typeof value.baseValue === 'object' && value.baseValue !== null && !Array.isArray(value.baseValue)
        ? value.baseValue
        : current,
      headTransitionId: typeof value.headTransitionId === 'string' ? value.headTransitionId : null,
    }), row.id);
  }
}

export function migrateDatabase(database: TavernDatabase): void {
  // SQLite requires this pragma to be changed outside a transaction. It is restored in finally,
  // while all schema/data changes and the schema-version write happen in one durable transaction.
  database.sqlite.pragma('foreign_keys = OFF');
  try {
    const startingVersion = readSchemaVersion(database);
    database.transaction(() => {
      database.sqlite.exec('CREATE TABLE IF NOT EXISTS tavernnext_schema_version (version INTEGER NOT NULL)');
      normalizeExtensionStatesTable(database);
      database.sqlite.exec(tables);

      if (hasCascadeWorldbookEntries(database)) rebuildWorldbookEntries(database);
      if (!columnNames(database, 'messages').includes('active_variant_id')) rebuildMessages(database);
      if (hasConversationGenerationBindings(database)) resetConversationGraph(database);

      addPromptSnapshotColumns(database);
      addVariantColumns(database);
      addSceneColumns(database);
      backfillCharacterDepthPrompt(database);
      if ((startingVersion ?? 0) < 12) backfillCharacterExtensionAssets(database);
      if ((startingVersion ?? 0) < 13) backfillPresetExtensionAssets(database);
      if ((startingVersion ?? 0) < 14) backfillOwnerExtensionStates(database);
      if ((startingVersion ?? 0) < 18) backfillSceneStateKernel(database);
      backfillConversationWorldbooks(database);
      seedGlobalGenerationConfig(database);
      if (startingVersion === 16) clearLegacyPublicAssets(database);
      database.sqlite.exec(indexes);
      database.sqlite.exec(`DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version (version) VALUES (${CURRENT_SCHEMA_VERSION});`);
    });
  } finally {
    database.sqlite.pragma('foreign_keys = ON');
  }
}
