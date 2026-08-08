import { and, asc, eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
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
import {
  characters,
  conversationWorldbooks,
  conversations,
  generationSnapshots,
  importArtifacts,
  messages,
  messageVariants,
  personas,
  presets,
  providerProfiles,
  worldbookEntries,
  worldbooks,
} from './schema.js';
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

type EntityRow = Record<string, unknown>;
type EntityTable = SQLiteTable & {
  id: typeof characters.id;
  revision: typeof characters.revision;
  createdAt: typeof characters.createdAt;
  updatedAt: typeof characters.updatedAt;
  payload: typeof characters.payload;
};

function entityTable(table: SQLiteTable): EntityTable {
  return table as unknown as EntityTable;
}

interface RepositoryDefinition<T extends MutableEntity> {
  table: EntityTable;
  schema: ZodType<T>;
  toRow: (value: T) => EntityRow;
  syncRelationships?: (database: TavernDatabase, value: T) => void;
}

function baseRow<T extends MutableEntity>(value: T): EntityRow {
  return {
    id: value.id,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    payload: value,
  };
}

function createRepository<T extends MutableEntity>(database: TavernDatabase, definition: RepositoryDefinition<T>): Repository<T> {
  const table = definition.table;
  const decode = (row: { payload: unknown } | undefined): T | undefined => row === undefined
    ? undefined
    : definition.schema.parse(row.payload);
  const get = (id: string) => decode(database.orm.select({ payload: table.payload }).from(table).where(eq(table.id, id)).get());

  return {
    create(input) {
      const now = new Date().toISOString();
      const value = definition.schema.parse({ ...input, revision: 0, createdAt: now, updatedAt: now });
      return database.transaction(() => {
        database.orm.insert(table).values(definition.toRow(value) as never).run();
        definition.syncRelationships?.(database, value);
        database.persist();
        return value;
      });
    },
    get,
    list() {
      return database.orm.select({ payload: table.payload }).from(table).orderBy(asc(table.createdAt)).all()
        .map((row) => definition.schema.parse(row.payload));
    },
    update(id, expectedRevision, patch) {
      return database.transaction(() => {
        const current = get(id);
        if (current === undefined) return { ok: false, reason: 'not_found' };
        const value = definition.schema.parse({
          ...current,
          ...patch,
          id: current.id,
          revision: current.revision + 1,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        });
        const { id: ignoredId, ...changes } = definition.toRow(value);
        void ignoredId;
        database.orm.update(table).set(changes as never)
          .where(and(eq(table.id, id), eq(table.revision, expectedRevision))).run();
        if (get(id)?.revision !== value.revision) return { ok: false, reason: 'conflict' };
        definition.syncRelationships?.(database, value);
        database.persist();
        return { ok: true, value };
      });
    },
    delete(id, expectedRevision) {
      return database.transaction(() => {
        if (get(id) === undefined) return { ok: false, reason: 'not_found' };
        database.orm.delete(table).where(and(eq(table.id, id), eq(table.revision, expectedRevision))).run();
        if (get(id) !== undefined) return { ok: false, reason: 'conflict' };
        database.persist();
        return { ok: true };
      });
    },
  };
}

function syncConversationWorldbooks(database: TavernDatabase, conversation: Conversation): void {
  database.orm.delete(conversationWorldbooks).where(eq(conversationWorldbooks.conversationId, conversation.id)).run();
  if (conversation.worldbookIds.length > 0) {
    database.orm.insert(conversationWorldbooks).values(
      conversation.worldbookIds.map((worldbookId) => ({ conversationId: conversation.id, worldbookId })),
    ).run();
  }
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
    characters: createRepository(database, { table: entityTable(characters), schema: CharacterSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    personas: createRepository(database, { table: entityTable(personas), schema: PersonaSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    worldbooks: createRepository(database, { table: entityTable(worldbooks), schema: WorldbookSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    worldbookEntries: createRepository(database, { table: entityTable(worldbookEntries), schema: WorldbookEntrySchema, toRow: (value) => ({ ...baseRow(value), worldbookId: value.worldbookId }) }),
    presets: createRepository(database, { table: entityTable(presets), schema: PresetSchema, toRow: (value) => ({ ...baseRow(value), name: value.name, kind: value.kind }) }),
    conversations: createRepository(database, { table: entityTable(conversations), schema: ConversationSchema, toRow: (value) => ({ ...baseRow(value), characterId: value.characterId, personaId: value.personaId, presetId: value.presetId ?? null, title: value.title }), syncRelationships: syncConversationWorldbooks }),
    messages: createRepository(database, { table: entityTable(messages), schema: MessageSchema, toRow: (value) => ({ ...baseRow(value), conversationId: value.conversationId, activeVariantId: value.activeVariantId, role: value.role }) }),
    messageVariants: createRepository(database, { table: entityTable(messageVariants), schema: MessageVariantSchema, toRow: (value) => ({ ...baseRow(value), messageId: value.messageId, status: value.status }) }),
    providerProfiles: createRepository(database, { table: entityTable(providerProfiles), schema: ProviderProfileSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    importArtifacts: createRepository(database, { table: entityTable(importArtifacts), schema: ImportArtifactSchema, toRow: (value) => ({ ...baseRow(value), kind: value.kind, entityId: value.entityId ?? null }) }),
    generationSnapshots: createRepository(database, { table: entityTable(generationSnapshots), schema: GenerationSnapshotSchema, toRow: (value) => ({ ...baseRow(value), conversationId: value.conversationId }) }),
  };
}
