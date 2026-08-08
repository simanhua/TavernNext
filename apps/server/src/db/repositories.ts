import type { ZodType } from 'zod';
import {
  CharacterSchema,
  ConversationSchema,
  GenerationSnapshotSchema,
  ImportArtifactSchema,
  MessageSchema,
  MessageVariantSchema,
  PersonaSchema,
  PresetSchema,
  ProviderProfileSchema,
  WorldbookEntrySchema,
  WorldbookSchema,
  type Character,
  type Conversation,
  type GenerationSnapshot,
  type ImportArtifact,
  type Message,
  type MessageVariant,
  type Persona,
  type Preset,
  type ProviderProfile,
  type Worldbook,
  type WorldbookEntry,
} from '@tavernnext/domain';
import type { TavernDatabase } from './client.js';

type MutableEntity = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type DefaultedField = 'enabled' | 'position' | 'order' | 'settings' | 'worldbookIds' | 'apiMode' | 'headerSecretRefs';
export type CreateInput<T extends MutableEntity> =
  Omit<T, 'revision' | 'createdAt' | 'updatedAt' | DefaultedField>
  & Partial<Pick<T, Extract<keyof T, DefaultedField>>>;
export type UpdateResult<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict' };
export type DeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'conflict' };

export interface Repository<T extends MutableEntity> {
  create(input: CreateInput<T>): T;
  get(id: string): T | undefined;
  list(): T[];
  update(id: string, expectedRevision: number, patch: Partial<CreateInput<T>>): UpdateResult<T>;
  delete(id: string, expectedRevision: number): DeleteResult;
}

interface RepositoryDefinition<T extends MutableEntity> {
  table: string;
  schema: ZodType<T>;
  indexedValues: (value: T) => Record<string, string | null>;
}

type StoredRow = { payload: string };

function createRepository<T extends MutableEntity>(database: TavernDatabase, definition: RepositoryDefinition<T>): Repository<T> {
  const decode = (row: StoredRow | undefined): T | undefined => row === undefined
    ? undefined
    : definition.schema.parse(JSON.parse(row.payload));

  return {
    create(input) {
      const now = new Date().toISOString();
      const value = definition.schema.parse({ ...input, revision: 0, createdAt: now, updatedAt: now });
      const indexedValues = definition.indexedValues(value);
      const columns = ['id', 'revision', 'created_at', 'updated_at', 'payload', ...Object.keys(indexedValues)];
      const values = [value.id, value.revision, value.createdAt, value.updatedAt, JSON.stringify(value), ...Object.values(indexedValues)];
      const placeholders = columns.map(() => '?').join(', ');
      database.sqlite.prepare(`INSERT INTO ${definition.table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
      return value;
    },
    get(id) {
      return decode(database.sqlite.prepare(`SELECT payload FROM ${definition.table} WHERE id = ?`).get(id) as StoredRow | undefined);
    },
    list() {
      return (database.sqlite.prepare(`SELECT payload FROM ${definition.table} ORDER BY created_at ASC`).all() as StoredRow[])
        .map((row) => definition.schema.parse(JSON.parse(row.payload)));
    },
    update(id, expectedRevision, patch) {
      const current = decode(database.sqlite.prepare(`SELECT payload FROM ${definition.table} WHERE id = ?`).get(id) as StoredRow | undefined);
      if (current === undefined) return { ok: false, reason: 'not_found' };

      const value = definition.schema.parse({
        ...current,
        ...patch,
        id: current.id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      const indexedValues = definition.indexedValues(value);
      const assignments = ['revision = ?', 'updated_at = ?', 'payload = ?', ...Object.keys(indexedValues).map((column) => `${column} = ?`)];
      const result = database.sqlite.prepare(
        `UPDATE ${definition.table} SET ${assignments.join(', ')} WHERE id = ? AND revision = ?`,
      ).run(value.revision, value.updatedAt, JSON.stringify(value), ...Object.values(indexedValues), id, expectedRevision);
      if (result.changes === 1) return { ok: true, value };
      return { ok: false, reason: 'conflict' };
    },
    delete(id, expectedRevision) {
      const existing = database.sqlite.prepare(`SELECT revision FROM ${definition.table} WHERE id = ?`).get(id) as { revision: number } | undefined;
      if (existing === undefined) return { ok: false, reason: 'not_found' };
      const result = database.sqlite.prepare(`DELETE FROM ${definition.table} WHERE id = ? AND revision = ?`).run(id, expectedRevision);
      return result.changes === 1 ? { ok: true } : { ok: false, reason: 'conflict' };
    },
  };
}

export interface Repositories {
  characters: Repository<Character>;
  personas: Repository<Persona>;
  worldbooks: Repository<Worldbook>;
  worldbookEntries: Repository<WorldbookEntry>;
  presets: Repository<Preset>;
  conversations: Repository<Conversation>;
  messages: Repository<Message>;
  messageVariants: Repository<MessageVariant>;
  providerProfiles: Repository<ProviderProfile>;
  importArtifacts: Repository<ImportArtifact>;
  generationSnapshots: Repository<GenerationSnapshot>;
}

export function createRepositories(database: TavernDatabase): Repositories {
  return {
    characters: createRepository(database, { table: 'characters', schema: CharacterSchema, indexedValues: (value) => ({ name: value.name }) }),
    personas: createRepository(database, { table: 'personas', schema: PersonaSchema, indexedValues: (value) => ({ name: value.name }) }),
    worldbooks: createRepository(database, { table: 'worldbooks', schema: WorldbookSchema, indexedValues: (value) => ({ name: value.name }) }),
    worldbookEntries: createRepository(database, { table: 'worldbook_entries', schema: WorldbookEntrySchema, indexedValues: (value) => ({ worldbook_id: value.worldbookId }) }),
    presets: createRepository(database, { table: 'presets', schema: PresetSchema, indexedValues: (value) => ({ name: value.name, kind: value.kind }) }),
    conversations: createRepository(database, { table: 'conversations', schema: ConversationSchema, indexedValues: (value) => ({ character_id: value.characterId, persona_id: value.personaId, preset_id: value.presetId ?? null, title: value.title }) }),
    messages: createRepository(database, { table: 'messages', schema: MessageSchema, indexedValues: (value) => ({ conversation_id: value.conversationId, role: value.role }) }),
    messageVariants: createRepository(database, { table: 'message_variants', schema: MessageVariantSchema, indexedValues: (value) => ({ message_id: value.messageId, status: value.status }) }),
    providerProfiles: createRepository(database, { table: 'provider_profiles', schema: ProviderProfileSchema, indexedValues: (value) => ({ name: value.name }) }),
    importArtifacts: createRepository(database, { table: 'import_artifacts', schema: ImportArtifactSchema, indexedValues: (value) => ({ kind: value.kind, entity_id: value.entityId ?? null }) }),
    generationSnapshots: createRepository(database, { table: 'generation_snapshots', schema: GenerationSnapshotSchema, indexedValues: (value) => ({ conversation_id: value.conversationId }) }),
  };
}
