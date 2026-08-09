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
  WorldbookRuntimeStateSchema,
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
  type WorldbookRuntimeState,
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
  worldbookRuntimeStates,
  worldbooks,
} from './schema.js';
import type { TavernDatabase } from './client.js';
import {
  SNAPSHOT_INTEGRITY_KEY_BYTES,
  createSnapshotIntegrityTag,
  verifySnapshotIntegrityTag,
} from './snapshot-integrity.js';

export const MAX_MESSAGES_PER_CONVERSATION = 2048;
export const MAX_VARIANTS_PER_RELATION = 4096;
export const MAX_ENTRIES_PER_WORLDBOOK = 4096;
export const MAX_GLOBAL_WORLDBOOKS = 64;

export type RelationshipLimitCode =
  | 'message_relation_limit'
  | 'variant_relation_limit'
  | 'worldbook_entry_relation_limit'
  | 'global_worldbook_relation_limit';

export class RelationshipLimitError extends Error {
  constructor(readonly code: RelationshipLimitCode) {
    super(code);
    this.name = 'RelationshipLimitError';
  }
}

export class SnapshotIntegrityError extends Error {
  constructor() {
    super('snapshot_integrity_invalid');
    this.name = 'SnapshotIntegrityError';
  }
}

type MutableEntity = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type DefaultedField =
  | 'enabled' | 'position' | 'order' | 'settings' | 'worldbookIds' | 'apiMode' | 'headerSecretRefs'
  | 'examples' | 'systemPrompt' | 'postHistoryInstructions' | 'creatorNotes' | 'creator' | 'characterVersion'
  | 'depthPrompt' | 'authorNote' | 'authorNotePosition' | 'authorNoteDepth' | 'authorNoteRole'
  | 'description' | 'scanDepth' | 'tokenBudget' | 'recursiveScanning' | 'extensions'
  | 'secondaryKeys' | 'useRegex' | 'selective' | 'selectiveLogic' | 'constant' | 'vectorized'
  | 'probability' | 'useProbability' | 'group' | 'groupWeight' | 'groupOverride' | 'priority'
  | 'depth' | 'role' | 'ignoreBudget' | 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring'
  | 'excludeRecursion' | 'preventRecursion' | 'delayUntilRecursion' | 'sticky' | 'cooldown' | 'delay'
  | 'characterFilter' | 'personaFilter' | 'matchPersonaDescription' | 'matchCharacterDescription'
  | 'matchCharacterPersonality' | 'matchCharacterDepthPrompt' | 'matchScenario' | 'matchCreatorNotes'
  | 'comment' | 'displayName' | 'addMemo' | 'displayIndex' | 'outletName' | 'automationId' | 'triggers'
  | 'isGlobal' | 'maxPromptTokens' | 'maxResponseTokens' | 'ordinal' | 'continuationBoundaries';
export type CreateInput<T extends MutableEntity> =
  Omit<T, 'revision' | 'createdAt' | 'updatedAt' | DefaultedField>
  & Partial<Pick<T, Extract<keyof T, DefaultedField>>>;
export type UpdateResult<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict' };
export type DeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'conflict' };

export interface Repository<T extends MutableEntity> {
  create(input: CreateInput<T>): T;
  get(id: string): T | undefined;
  list(limit?: number): T[];
  update(id: string, expectedRevision: number, patch: Partial<CreateInput<T>>): UpdateResult<T>;
  delete(id: string, expectedRevision: number): DeleteResult;
}

export interface ImmutableRepository<T extends MutableEntity> {
  create(input: CreateInput<T>): T;
  get(id: string): T | undefined;
  list(): T[];
}

export interface WorldbookEntryRepository extends Repository<WorldbookEntry> {
  listByWorldbookId(worldbookId: string): WorldbookEntry[];
}

export interface WorldbookRepository extends Repository<Worldbook> {
  listGlobal(): Worldbook[];
}

export interface WorldbookRuntimeStateRepository extends Repository<WorldbookRuntimeState> {
  getByConversationId(conversationId: string): WorldbookRuntimeState | undefined;
}

export interface MessageRepository extends Repository<Message> {
  listByConversationId(conversationId: string): Message[];
}

export interface MessageVariantRepository extends Repository<MessageVariant> {
  listByMessageId(messageId: string): MessageVariant[];
  listByConversationId(conversationId: string): MessageVariant[];
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
    list(limit) {
      const query = database.orm.select({ payload: table.payload }).from(table).orderBy(asc(table.createdAt), asc(table.id));
      const rows = limit === undefined ? query.all() : query.limit(limit).all();
      return rows.map((row) => definition.schema.parse(row.payload));
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

function createPersonaRepository(database: TavernDatabase): Repository<Persona> {
  const base = createRepository(database, {
    table: entityTable(personas),
    schema: PersonaSchema,
    toRow: (value: Persona) => ({ ...baseRow(value), name: value.name }),
  });
  const unsetOtherDefaults = (id: string) => {
    for (const persona of base.list()) {
      if (persona.id === id || !persona.isDefault) continue;
      const updated = base.update(persona.id, persona.revision, { isDefault: false });
      if (!updated.ok) throw new Error('Could not update Persona default');
    }
  };
  const promoteOldest = (excludedId?: string) => {
    const candidate = base.list().find((persona) => persona.id !== excludedId);
    if (candidate === undefined || candidate.isDefault) return;
    const updated = base.update(candidate.id, candidate.revision, { isDefault: true });
    if (!updated.ok) throw new Error('Could not promote Persona default');
  };
  return {
    create(input) {
      return database.transaction(() => {
        const shouldDefault = base.list().length === 0 || input.isDefault === true;
        if (shouldDefault) unsetOtherDefaults(input.id);
        return base.create({ ...input, isDefault: shouldDefault });
      });
    },
    get: base.get,
    list: base.list,
    update(id, expectedRevision, patch) {
      return database.transaction(() => {
        const current = base.get(id);
        if (current === undefined) return { ok: false, reason: 'not_found' };
        if (current.revision !== expectedRevision) return { ok: false, reason: 'conflict' };
        const requestsDefault = patch.isDefault === true;
        if (requestsDefault) unsetOtherDefaults(id);
        const keepsOnlyDefault = current.isDefault && patch.isDefault === false && base.list().every((persona) => persona.id === id || !persona.isDefault);
        const result = base.update(id, expectedRevision, keepsOnlyDefault ? { ...patch, isDefault: true } : patch);
        if (result.ok && current.isDefault && !result.value.isDefault) promoteOldest(id);
        return result;
      });
    },
    delete(id, expectedRevision) {
      return database.transaction(() => {
        const current = base.get(id);
        if (current === undefined) return { ok: false, reason: 'not_found' };
        if (current.revision !== expectedRevision) return { ok: false, reason: 'conflict' };
        const result = base.delete(id, expectedRevision);
        if (result.ok && current.isDefault) promoteOldest(id);
        return result;
      });
    },
  };
}

function createWorldbookEntryRepository(database: TavernDatabase): WorldbookEntryRepository {
  const base = createRepository(database, {
    table: entityTable(worldbookEntries),
    schema: WorldbookEntrySchema,
    toRow: (value: WorldbookEntry) => ({ ...baseRow(value), worldbookId: value.worldbookId }),
  });
  return {
    ...base,
    listByWorldbookId(worldbookId: string) {
      const rows = database.orm.select({ payload: worldbookEntries.payload })
        .from(worldbookEntries)
        .where(eq(worldbookEntries.worldbookId, worldbookId))
        .orderBy(asc(worldbookEntries.createdAt), asc(worldbookEntries.id))
        .limit(MAX_ENTRIES_PER_WORLDBOOK + 1)
        .all();
      if (rows.length > MAX_ENTRIES_PER_WORLDBOOK) {
        throw new RelationshipLimitError('worldbook_entry_relation_limit');
      }
      return rows.map((row) => WorldbookEntrySchema.parse(row.payload));
    },
  };
}

function createMessageRepository(database: TavernDatabase): MessageRepository {
  const base = createRepository(database, {
    table: entityTable(messages),
    schema: MessageSchema,
    toRow: (value: Message) => ({
      ...baseRow(value),
      conversationId: value.conversationId,
      activeVariantId: value.activeVariantId,
      role: value.role,
    }),
  });
  return {
    ...base,
    listByConversationId(conversationId) {
      const rows = database.orm.select({ payload: messages.payload })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(MAX_MESSAGES_PER_CONVERSATION + 1)
        .all();
      if (rows.length > MAX_MESSAGES_PER_CONVERSATION) {
        throw new RelationshipLimitError('message_relation_limit');
      }
      return rows.map((row) => MessageSchema.parse(row.payload));
    },
  };
}

function createMessageVariantRepository(database: TavernDatabase): MessageVariantRepository {
  const base = createRepository(database, {
    table: entityTable(messageVariants),
    schema: MessageVariantSchema,
    toRow: (value: MessageVariant) => ({
      ...baseRow(value),
      messageId: value.messageId,
      ordinal: value.ordinal,
      status: value.status,
    }),
  });
  const decode = (rows: Array<{ payload: unknown }>) => {
    if (rows.length > MAX_VARIANTS_PER_RELATION) throw new RelationshipLimitError('variant_relation_limit');
    return rows.map((row) => MessageVariantSchema.parse(row.payload));
  };
  return {
    ...base,
    listByMessageId(messageId) {
      return decode(database.orm.select({ payload: messageVariants.payload })
        .from(messageVariants)
        .where(eq(messageVariants.messageId, messageId))
        .orderBy(asc(messageVariants.ordinal), asc(messageVariants.createdAt), asc(messageVariants.id))
        .limit(MAX_VARIANTS_PER_RELATION + 1)
        .all());
    },
    listByConversationId(conversationId) {
      const parentRows = database.orm.select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(MAX_MESSAGES_PER_CONVERSATION + 1)
        .all();
      if (parentRows.length > MAX_MESSAGES_PER_CONVERSATION) {
        throw new RelationshipLimitError('variant_relation_limit');
      }
      const rows: Array<{ payload: unknown }> = [];
      for (const parent of parentRows) {
        const remaining = MAX_VARIANTS_PER_RELATION + 1 - rows.length;
        const related = database.orm.select({ payload: messageVariants.payload })
          .from(messageVariants)
          .where(eq(messageVariants.messageId, parent.id))
          .orderBy(asc(messageVariants.ordinal), asc(messageVariants.createdAt), asc(messageVariants.id))
          .limit(remaining)
          .all();
        rows.push(...related);
        if (rows.length > MAX_VARIANTS_PER_RELATION) {
          throw new RelationshipLimitError('variant_relation_limit');
        }
      }
      return decode(rows);
    },
  };
}

function createWorldbookRepository(database: TavernDatabase): WorldbookRepository {
  const base = createRepository(database, {
    table: entityTable(worldbooks),
    schema: WorldbookSchema,
    toRow: (value: Worldbook) => ({ ...baseRow(value), name: value.name, isGlobal: value.isGlobal }),
  });
  return {
    ...base,
    listGlobal() {
      const rows = database.orm.select({ payload: worldbooks.payload })
        .from(worldbooks)
        .where(eq(worldbooks.isGlobal, true))
        .orderBy(asc(worldbooks.createdAt), asc(worldbooks.id))
        .limit(MAX_GLOBAL_WORLDBOOKS + 1)
        .all();
      if (rows.length > MAX_GLOBAL_WORLDBOOKS) {
        throw new RelationshipLimitError('global_worldbook_relation_limit');
      }
      return rows.map((row) => WorldbookSchema.parse(row.payload));
    },
  };
}

interface SnapshotStorageRow {
  id: string;
  conversationId: string;
  integrityTag: string | null;
  payload: unknown;
}

function snapshotConversationRevision(artifact: unknown): unknown {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) return null;
  return Reflect.get(artifact, 'conversationRevision');
}

function snapshotEnvelope(row: Pick<SnapshotStorageRow, 'id' | 'conversationId' | 'payload'>) {
  return {
    snapshotId: row.id,
    conversationId: row.conversationId,
    conversationRevision: snapshotConversationRevision(row.payload),
    artifact: row.payload,
  };
}

function persistedJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SnapshotIntegrityError();
  return JSON.parse(encoded);
}

function createGenerationSnapshotRepository(
  database: TavernDatabase,
  snapshotIntegrityKey: Uint8Array,
): ImmutableRepository<GenerationSnapshot> {
  if (snapshotIntegrityKey.byteLength !== SNAPSHOT_INTEGRITY_KEY_BYTES) {
    throw new Error(`Snapshot integrity key must be exactly ${SNAPSHOT_INTEGRITY_KEY_BYTES} bytes.`);
  }
  const key = Uint8Array.from(snapshotIntegrityKey);
  const decode = (row: SnapshotStorageRow | undefined): GenerationSnapshot | undefined => {
    if (row === undefined) return undefined;
    if (!verifySnapshotIntegrityTag(key, snapshotEnvelope(row), row.integrityTag)) {
      throw new SnapshotIntegrityError();
    }
    const parsed = GenerationSnapshotSchema.safeParse(row.payload);
    if (!parsed.success
      || parsed.data.id !== row.id
      || parsed.data.conversationId !== row.conversationId) {
      throw new SnapshotIntegrityError();
    }
    return parsed.data;
  };

  return {
    create(input) {
      const now = new Date().toISOString();
      const value = GenerationSnapshotSchema.parse(persistedJson({
        ...input,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }));
      const row = { id: value.id, conversationId: value.conversationId, payload: value };
      const integrityTag = createSnapshotIntegrityTag(key, snapshotEnvelope(row));
      return database.transaction(() => {
        database.orm.insert(generationSnapshots).values({
          id: value.id,
          revision: value.revision,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          payload: value,
          conversationId: value.conversationId,
          integrityTag,
        }).run();
        database.persist();
        return value;
      });
    },
    get(id) {
      return decode(database.orm.select({
        id: generationSnapshots.id,
        conversationId: generationSnapshots.conversationId,
        integrityTag: generationSnapshots.integrityTag,
        payload: generationSnapshots.payload,
      }).from(generationSnapshots).where(eq(generationSnapshots.id, id)).get());
    },
    list() {
      return database.orm.select({
        id: generationSnapshots.id,
        conversationId: generationSnapshots.conversationId,
        integrityTag: generationSnapshots.integrityTag,
        payload: generationSnapshots.payload,
      }).from(generationSnapshots)
        .orderBy(asc(generationSnapshots.createdAt), asc(generationSnapshots.id))
        .all()
        .map((row) => decode(row)!);
    },
  };
}

function createWorldbookRuntimeStateRepository(database: TavernDatabase): WorldbookRuntimeStateRepository {
  const base = createRepository(database, {
    table: entityTable(worldbookRuntimeStates),
    schema: WorldbookRuntimeStateSchema,
    toRow: (value: WorldbookRuntimeState) => ({ ...baseRow(value), conversationId: value.conversationId }),
  });
  return {
    ...base,
    getByConversationId(conversationId) {
      const row = database.orm.select({ payload: worldbookRuntimeStates.payload })
        .from(worldbookRuntimeStates)
        .where(eq(worldbookRuntimeStates.conversationId, conversationId))
        .get();
      return row === undefined ? undefined : WorldbookRuntimeStateSchema.parse(row.payload);
    },
  };
}

export interface Repositories {
  characters: Repository<Character>;
  personas: Repository<Persona>;
  worldbooks: WorldbookRepository;
  worldbookEntries: WorldbookEntryRepository;
  presets: Repository<Preset>;
  conversations: Repository<Conversation>;
  messages: MessageRepository;
  messageVariants: MessageVariantRepository;
  providerProfiles: Repository<ProviderProfile>;
  importArtifacts: Repository<ImportArtifact>;
  generationSnapshots: ImmutableRepository<GenerationSnapshot>;
  worldbookRuntimeStates: WorldbookRuntimeStateRepository;
}

export interface CreateRepositoriesOptions {
  snapshotIntegrityKey: Uint8Array;
}

export function createRepositories(database: TavernDatabase, options: CreateRepositoriesOptions): Repositories {
  return {
    characters: createRepository(database, { table: entityTable(characters), schema: CharacterSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    personas: createPersonaRepository(database),
    worldbooks: createWorldbookRepository(database),
    worldbookEntries: createWorldbookEntryRepository(database),
    presets: createRepository(database, { table: entityTable(presets), schema: PresetSchema, toRow: (value) => ({ ...baseRow(value), name: value.name, kind: value.kind }) }),
    conversations: createRepository(database, { table: entityTable(conversations), schema: ConversationSchema, toRow: (value) => ({
      ...baseRow(value),
      characterId: value.characterId,
      personaId: value.personaId,
      providerId: value.providerId ?? null,
      presetId: value.presetId ?? null,
      contextPresetId: value.contextPresetId ?? null,
      instructPresetId: value.instructPresetId ?? null,
      systemPresetId: value.systemPresetId ?? null,
      title: value.title,
    }), syncRelationships: syncConversationWorldbooks }),
    messages: createMessageRepository(database),
    messageVariants: createMessageVariantRepository(database),
    providerProfiles: createRepository(database, { table: entityTable(providerProfiles), schema: ProviderProfileSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    importArtifacts: createRepository(database, { table: entityTable(importArtifacts), schema: ImportArtifactSchema, toRow: (value) => ({ ...baseRow(value), kind: value.kind, entityId: value.entityId ?? null }) }),
    generationSnapshots: createGenerationSnapshotRepository(database, options.snapshotIntegrityKey),
    worldbookRuntimeStates: createWorldbookRuntimeStateRepository(database),
  };
}
