import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { and, asc, eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { ZodType } from 'zod';
import {
  CharacterSchema,
  ConversationSchema,
  ExtensionAssetSchema,
  ExtensionStateSchema,
  ExtensionTrustGrantSchema,
  ExtensionRemoteResourceSchema,
  ExtensionAuditEventSchema,
  GenerationSnapshotSchema,
  GLOBAL_GENERATION_CONFIG_ID,
  GlobalGenerationConfigSchema,
  ImportArtifactSchema,
  InstalledSceneSchema,
  MessageSchema,
  MessageVariantSchema,
  PersonaSchema,
  PresetSchema,
  ProviderProfileSchema,
  WorldbookEntrySchema,
  WorldbookRuntimeStateSchema,
  WorldbookSchema,
  ConversationSceneStateSchema,
  SceneStateTransitionSchema,
  type Character,
  type Conversation,
  type ExtensionAsset,
  type ExtensionOwnerKind,
  type ExtensionState,
  type ExtensionStateScope,
  type ExtensionTrustGrant,
  type ExtensionRemoteResource,
  type ExtensionAuditEvent,
  type GenerationSnapshot,
  type GlobalGenerationConfig,
  type GlobalGenerationSelection,
  type ImportArtifact,
  type InstalledScene,
  type Message,
  type MessageVariant,
  type Persona,
  type Preset,
  type ProviderProfile,
  type Worldbook,
  type WorldbookEntry,
  type WorldbookRuntimeState,
  type ConversationSceneState,
  type SceneStateTransition,
  type SceneStateTransitionSourceKind,
} from '@tavernnext/domain';
import {
  characters,
  conversationWorldbooks,
  conversations,
  extensionAssets,
  extensionStates,
  extensionTrustGrants,
  extensionRemoteResources,
  extensionAuditEvents,
  generationSnapshots,
  globalGenerationConfigurations,
  importArtifacts,
  installedScenes,
  messages,
  messageVariants,
  personas,
  presets,
  providerProfiles,
  worldbookEntries,
  worldbookRuntimeStates,
  worldbooks,
  conversationSceneStates,
  sceneStateTransitions,
} from './schema.js';
import type { TavernDatabase } from './client.js';
import {
  SNAPSHOT_INTEGRITY_KEY_BYTES,
  createSnapshotIntegrityTag,
  verifySnapshotIntegrityTag,
} from './snapshot-integrity.js';
import { assertExtensionAssetLimit, MAX_EXTENSION_ASSETS_PER_OWNER } from '../extension-assets.js';
import { assertRuntimeStateValue } from '../runtime-state-validation.js';

export const MAX_MESSAGES_PER_CONVERSATION = 2048;
export const MAX_VARIANTS_PER_RELATION = 4096;
export const MAX_ENTRIES_PER_WORLDBOOK = 4096;
export const MAX_GLOBAL_WORLDBOOKS = 64;

export type RelationshipLimitCode =
  | 'message_relation_limit'
  | 'variant_relation_limit'
  | 'worldbook_entry_relation_limit'
  | 'global_worldbook_relation_limit'
  | 'extension_asset_relation_limit';

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
  | 'isGlobal' | 'maxPromptTokens' | 'maxResponseTokens' | 'ordinal' | 'continuationBoundaries'
  | 'diagnostics' | 'setup' | 'schemaVersion' | 'baseValue' | 'headTransitionId'
  | 'parentTransitionId' | 'operations' | 'value' | 'sceneInternal';
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
  deleteByWorldbookId(worldbookId: string): void;
}

export interface WorldbookRepository extends Repository<Worldbook> {
  hasExternalReferences(worldbookId: string): boolean;
  listGlobal(): Worldbook[];
}

export interface WorldbookRuntimeStateRepository extends Repository<WorldbookRuntimeState> {
  getByConversationId(conversationId: string): WorldbookRuntimeState | undefined;
}

export interface ConversationSceneStateRepository extends Repository<ConversationSceneState> {
  getByConversationId(conversationId: string): ConversationSceneState | undefined;
  deleteByConversationId(conversationId: string): number;
}

export interface SceneStateTransitionRepository extends Repository<SceneStateTransition> {
  listByConversationId(conversationId: string): SceneStateTransition[];
  getBySource(sourceKind: SceneStateTransitionSourceKind, sourceId: string): SceneStateTransition | undefined;
  hasChildren(transitionId: string): boolean;
  deleteBySource(sourceKind: SceneStateTransitionSourceKind, sourceId: string): number;
}

export type AvatarAssetKind = 'characters' | 'personas';

export interface AvatarAsset {
  path: string;
  kind: AvatarAssetKind;
  ownerId: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface AvatarAssetRepository {
  getOwned(path: string, kind: AvatarAssetKind, ownerId: string): AvatarAsset | undefined;
  put(value: AvatarAsset): void;
  deleteOwned(path: string, kind: AvatarAssetKind, ownerId: string): boolean;
  deleteByOwner(kind: AvatarAssetKind, ownerId: string): number;
}

export interface ExtensionAssetRepository extends Repository<ExtensionAsset> {
  listByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): ExtensionAsset[];
  deleteByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): number;
}

export interface ExtensionStateRepository extends Repository<ExtensionState> {
  getByScope(scope: ExtensionStateScope, scopeId: string): ExtensionState | undefined;
  deleteByScope(scope: ExtensionStateScope, scopeId: string): number;
  deleteScriptStatesByOwner(ownerKind: 'character' | 'preset', ownerId: string): number;
}

export interface ExtensionTrustGrantRepository extends Repository<ExtensionTrustGrant> {
  getByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): ExtensionTrustGrant | undefined;
  deleteByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): number;
}
export interface ExtensionRemoteResourceRepository extends Repository<ExtensionRemoteResource> {
  listByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): ExtensionRemoteResource[];
  getByOwnerUrl(ownerKind: ExtensionOwnerKind, ownerId: string, url: string): ExtensionRemoteResource | undefined;
  deleteByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): number;
}
export interface ExtensionAuditEventRepository extends Repository<ExtensionAuditEvent> {
  listByOwner(ownerKind: ExtensionOwnerKind, ownerId: string): ExtensionAuditEvent[];
}

export interface MessageRepository extends Repository<Message> {
  listByConversationId(conversationId: string): Message[];
}

export interface MessageVariantRepository extends Repository<MessageVariant> {
  listByMessageId(messageId: string): MessageVariant[];
  listByConversationId(conversationId: string): MessageVariant[];
}

export interface ConversationRepository extends Repository<Conversation> {
  createWithGreeting(input: CreateInput<Conversation>): Conversation;
}

export interface GlobalGenerationConfigRepository {
  get(): GlobalGenerationConfig;
  update(expectedRevision: number, patch: Partial<GlobalGenerationSelection>): UpdateResult<GlobalGenerationConfig>;
  clearProvider(providerId: string): GlobalGenerationConfig;
  clearPreset(presetId: string): GlobalGenerationConfig;
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

function createAvatarAssetRepository(database: TavernDatabase): AvatarAssetRepository {
  return {
    getOwned(path, kind, ownerId) {
      const row = database.sqlite.prepare(
        'SELECT path, kind, owner_id, media_type, bytes FROM avatar_assets WHERE path = ? AND kind = ? AND owner_id = ?',
      ).get(path, kind, ownerId);
      if (row === undefined || !(row.bytes instanceof Uint8Array)) return undefined;
      return {
        path: String(row.path),
        kind: String(row.kind) as AvatarAssetKind,
        ownerId: String(row.owner_id),
        mediaType: String(row.media_type),
        bytes: Uint8Array.from(row.bytes),
      };
    },
    put(value) {
      database.sqlite.prepare(
        'INSERT INTO avatar_assets (path, kind, owner_id, media_type, bytes) VALUES (?, ?, ?, ?, ?)',
      ).run(value.path, value.kind, value.ownerId, value.mediaType, value.bytes);
    },
    deleteOwned(path, kind, ownerId) {
      return database.sqlite.prepare(
        'DELETE FROM avatar_assets WHERE path = ? AND kind = ? AND owner_id = ?',
      ).run(path, kind, ownerId).changes === 1;
    },
    deleteByOwner(kind, ownerId) {
      return database.sqlite.prepare(
        'DELETE FROM avatar_assets WHERE kind = ? AND owner_id = ?',
      ).run(kind, ownerId).changes;
    },
  };
}

function createExtensionAssetRepository(database: TavernDatabase): ExtensionAssetRepository {
  const base = createRepository(database, {
    table: entityTable(extensionAssets),
    schema: ExtensionAssetSchema,
    toRow: (value: ExtensionAsset) => ({
      ...baseRow(value),
      ownerKind: value.ownerKind,
      ownerId: value.ownerId,
      kind: value.kind,
      sourceKey: value.sourceKey,
      ordinal: value.ordinal,
      enabled: value.enabled,
    }),
  });
  return {
    ...base,
    create(input) {
      const current = database.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM extension_assets WHERE owner_kind = ? AND owner_id = ?',
      ).get(input.ownerKind, input.ownerId);
      assertExtensionAssetLimit(Number(current?.count ?? 0) + 1);
      return base.create(input);
    },
    listByOwner(ownerKind, ownerId) {
      const rows = database.orm.select({ payload: extensionAssets.payload })
        .from(extensionAssets)
        .where(and(eq(extensionAssets.ownerKind, ownerKind), eq(extensionAssets.ownerId, ownerId)))
        .orderBy(asc(extensionAssets.kind), asc(extensionAssets.ordinal), asc(extensionAssets.id))
        .limit(MAX_EXTENSION_ASSETS_PER_OWNER + 1)
        .all();
      if (rows.length > MAX_EXTENSION_ASSETS_PER_OWNER) {
        throw new RelationshipLimitError('extension_asset_relation_limit');
      }
      return rows.map((row) => ExtensionAssetSchema.parse(row.payload));
    },
    deleteByOwner(ownerKind, ownerId) {
      const changes = database.sqlite.prepare(
        'DELETE FROM extension_assets WHERE owner_kind = ? AND owner_id = ?',
      ).run(ownerKind, ownerId).changes;
      database.persist();
      return changes;
    },
  };
}

function createExtensionStateRepository(database: TavernDatabase): ExtensionStateRepository {
  const base = createRepository(database, {
    table: entityTable(extensionStates),
    schema: ExtensionStateSchema,
    toRow: (value: ExtensionState) => ({
      ...baseRow(value), scope: value.scope, scopeId: value.scopeId,
    }),
  });
  return {
    ...base,
    create(input) {
      assertRuntimeStateValue(input.value);
      return base.create(input);
    },
    update(id, expectedRevision, patch) {
      if (patch.value !== undefined) assertRuntimeStateValue(patch.value);
      return base.update(id, expectedRevision, patch);
    },
    getByScope(scope, scopeId) {
      const row = database.orm.select({ payload: extensionStates.payload })
        .from(extensionStates)
        .where(and(eq(extensionStates.scope, scope), eq(extensionStates.scopeId, scopeId)))
        .get();
      return row === undefined ? undefined : ExtensionStateSchema.parse(row.payload);
    },
    deleteByScope(scope, scopeId) {
      const changes = database.sqlite.prepare(
        'DELETE FROM extension_states WHERE scope = ? AND scope_id = ?',
      ).run(scope, scopeId).changes;
      database.persist();
      return changes;
    },
    deleteScriptStatesByOwner(ownerKind, ownerId) {
      const changes = database.sqlite.prepare(
        "DELETE FROM extension_states WHERE scope = 'script' AND scope_id LIKE ?",
      ).run(`${ownerKind}:${ownerId}:%`).changes;
      database.persist();
      return changes;
    },
  };
}

function createExtensionTrustGrantRepository(database: TavernDatabase): ExtensionTrustGrantRepository {
  const base = createRepository(database, {
    table: entityTable(extensionTrustGrants), schema: ExtensionTrustGrantSchema,
    toRow: (value: ExtensionTrustGrant) => ({ ...baseRow(value), ownerKind: value.ownerKind, ownerId: value.ownerId }),
  });
  return {
    ...base,
    getByOwner(ownerKind, ownerId) {
      const row = database.orm.select({ payload: extensionTrustGrants.payload }).from(extensionTrustGrants)
        .where(and(eq(extensionTrustGrants.ownerKind, ownerKind), eq(extensionTrustGrants.ownerId, ownerId))).get();
      return row === undefined ? undefined : ExtensionTrustGrantSchema.parse(row.payload);
    },
    deleteByOwner(ownerKind, ownerId) {
      const changes = database.sqlite.prepare(
        'DELETE FROM extension_trust_grants WHERE owner_kind = ? AND owner_id = ?',
      ).run(ownerKind, ownerId).changes;
      database.persist(); return changes;
    },
  };
}

function createExtensionRemoteResourceRepository(database: TavernDatabase): ExtensionRemoteResourceRepository {
  const base = createRepository(database, {
    table: entityTable(extensionRemoteResources), schema: ExtensionRemoteResourceSchema,
    toRow: (value: ExtensionRemoteResource) => ({
      ...baseRow(value), ownerKind: value.ownerKind, ownerId: value.ownerId, url: value.url, sha256: value.sha256,
    }),
  });
  return {
    ...base,
    listByOwner(ownerKind, ownerId) {
      return database.orm.select({ payload: extensionRemoteResources.payload }).from(extensionRemoteResources)
        .where(and(eq(extensionRemoteResources.ownerKind, ownerKind), eq(extensionRemoteResources.ownerId, ownerId)))
        .orderBy(asc(extensionRemoteResources.url)).all()
        .map((row) => ExtensionRemoteResourceSchema.parse(row.payload));
    },
    getByOwnerUrl(ownerKind, ownerId, url) {
      const row = database.orm.select({ payload: extensionRemoteResources.payload }).from(extensionRemoteResources)
        .where(and(eq(extensionRemoteResources.ownerKind, ownerKind), eq(extensionRemoteResources.ownerId, ownerId), eq(extensionRemoteResources.url, url))).get();
      return row === undefined ? undefined : ExtensionRemoteResourceSchema.parse(row.payload);
    },
    deleteByOwner(ownerKind, ownerId) {
      const changes = database.sqlite.prepare(
        'DELETE FROM extension_remote_resources WHERE owner_kind = ? AND owner_id = ?',
      ).run(ownerKind, ownerId).changes;
      database.persist(); return changes;
    },
  };
}

function createExtensionAuditEventRepository(database: TavernDatabase): ExtensionAuditEventRepository {
  const base = createRepository(database, {
    table: entityTable(extensionAuditEvents), schema: ExtensionAuditEventSchema,
    toRow: (value: ExtensionAuditEvent) => ({
      ...baseRow(value), ownerKind: value.ownerKind, ownerId: value.ownerId, event: value.event,
    }),
  });
  return {
    ...base,
    listByOwner(ownerKind, ownerId) {
      return database.orm.select({ payload: extensionAuditEvents.payload }).from(extensionAuditEvents)
        .where(and(eq(extensionAuditEvents.ownerKind, ownerKind), eq(extensionAuditEvents.ownerId, ownerId)))
        .orderBy(asc(extensionAuditEvents.createdAt), asc(extensionAuditEvents.id)).limit(2048).all()
        .map((row) => ExtensionAuditEventSchema.parse(row.payload));
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
    deleteByWorldbookId(worldbookId: string) {
      database.orm.delete(worldbookEntries).where(eq(worldbookEntries.worldbookId, worldbookId)).run();
      database.persist();
    },
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
    hasExternalReferences(worldbookId: string) {
      const characterReference = database.sqlite.prepare(
        "SELECT 1 AS present FROM characters WHERE json_extract(payload, '$.worldbookId') = ? LIMIT 1",
      ).get(worldbookId);
      if (characterReference !== undefined) return true;
      return database.sqlite.prepare(
        'SELECT 1 AS present FROM conversation_worldbooks WHERE worldbook_id = ? LIMIT 1',
      ).get(worldbookId) !== undefined;
    },
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

const SNAPSHOT_COMPRESSION_THRESHOLD_BYTES = 512 * 1024;
const SNAPSHOT_COMPRESSION_FORMAT = 'tavernnext-gzip-json-v1';

function encodeSnapshotStorage(value: GenerationSnapshot): unknown {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) < SNAPSHOT_COMPRESSION_THRESHOLD_BYTES) return value;
  return {
    format: SNAPSHOT_COMPRESSION_FORMAT,
    conversationRevision: value.conversationRevision,
    data: gzipSync(json).toString('base64'),
  };
}

function decodeSnapshotStorage(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.get(value, 'format') !== SNAPSHOT_COMPRESSION_FORMAT
    || typeof Reflect.get(value, 'data') !== 'string') return value;
  try {
    return JSON.parse(gunzipSync(Buffer.from(Reflect.get(value, 'data'), 'base64')).toString('utf8')) as unknown;
  } catch {
    throw new SnapshotIntegrityError();
  }
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
    const parsed = GenerationSnapshotSchema.safeParse(decodeSnapshotStorage(row.payload));
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
      const storagePayload = encodeSnapshotStorage(value);
      const row = { id: value.id, conversationId: value.conversationId, payload: storagePayload };
      const integrityTag = createSnapshotIntegrityTag(key, snapshotEnvelope(row));
      return database.transaction(() => {
        database.orm.insert(generationSnapshots).values({
          id: value.id,
          revision: value.revision,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          payload: storagePayload,
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
  installedScenes: Repository<InstalledScene>;
  characters: Repository<Character>;
  personas: Repository<Persona>;
  worldbooks: WorldbookRepository;
  worldbookEntries: WorldbookEntryRepository;
  presets: Repository<Preset>;
  conversations: ConversationRepository;
  messages: MessageRepository;
  messageVariants: MessageVariantRepository;
  providerProfiles: Repository<ProviderProfile>;
  globalGenerationConfig: GlobalGenerationConfigRepository;
  importArtifacts: Repository<ImportArtifact>;
  generationSnapshots: ImmutableRepository<GenerationSnapshot>;
  worldbookRuntimeStates: WorldbookRuntimeStateRepository;
  conversationSceneStates: ConversationSceneStateRepository;
  sceneStateTransitions: SceneStateTransitionRepository;
  avatarAssets: AvatarAssetRepository;
  extensionAssets: ExtensionAssetRepository;
  extensionStates: ExtensionStateRepository;
  extensionTrustGrants: ExtensionTrustGrantRepository;
  extensionRemoteResources: ExtensionRemoteResourceRepository;
  extensionAuditEvents: ExtensionAuditEventRepository;
}

function createConversationSceneStateRepository(database: TavernDatabase): ConversationSceneStateRepository {
  const base = createRepository(database, {
    table: entityTable(conversationSceneStates),
    schema: ConversationSceneStateSchema,
    toRow: (value: ConversationSceneState) => ({ ...baseRow(value), conversationId: value.conversationId }),
  });
  return {
    ...base,
    getByConversationId(conversationId) {
      const row = database.orm.select({ payload: conversationSceneStates.payload })
        .from(conversationSceneStates)
        .where(eq(conversationSceneStates.conversationId, conversationId))
        .get();
      return row === undefined ? undefined : ConversationSceneStateSchema.parse(row.payload);
    },
    deleteByConversationId(conversationId) {
      return database.sqlite.prepare('DELETE FROM conversation_scene_states WHERE conversation_id = ?')
        .run(conversationId).changes;
    },
  };
}

function createSceneStateTransitionRepository(database: TavernDatabase): SceneStateTransitionRepository {
  const base = createRepository(database, {
    table: entityTable(sceneStateTransitions),
    schema: SceneStateTransitionSchema,
    toRow: (value: SceneStateTransition) => ({
      ...baseRow(value),
      conversationId: value.conversationId,
      parentTransitionId: value.parentTransitionId,
      sourceKind: value.sourceKind,
      sourceId: value.sourceId,
    }),
  });
  return {
    ...base,
    listByConversationId(conversationId) {
      return database.orm.select({ payload: sceneStateTransitions.payload })
        .from(sceneStateTransitions)
        .where(eq(sceneStateTransitions.conversationId, conversationId))
        .orderBy(asc(sceneStateTransitions.createdAt), asc(sceneStateTransitions.id))
        .limit(MAX_VARIANTS_PER_RELATION + 1)
        .all()
        .map((row) => SceneStateTransitionSchema.parse(row.payload));
    },
    getBySource(sourceKind, sourceId) {
      const row = database.orm.select({ payload: sceneStateTransitions.payload })
        .from(sceneStateTransitions)
        .where(and(eq(sceneStateTransitions.sourceKind, sourceKind), eq(sceneStateTransitions.sourceId, sourceId)))
        .orderBy(asc(sceneStateTransitions.createdAt), asc(sceneStateTransitions.id))
        .get();
      return row === undefined ? undefined : SceneStateTransitionSchema.parse(row.payload);
    },
    hasChildren(transitionId) {
      return database.orm.select({ id: sceneStateTransitions.id })
        .from(sceneStateTransitions)
        .where(eq(sceneStateTransitions.parentTransitionId, transitionId))
        .limit(1)
        .get() !== undefined;
    },
    deleteBySource(sourceKind, sourceId) {
      return database.sqlite.prepare(
        'DELETE FROM scene_state_transitions WHERE source_kind = ? AND source_id = ?',
      ).run(sourceKind, sourceId).changes;
    },
  };
}

export interface CreateRepositoriesOptions {
  snapshotIntegrityKey: Uint8Array;
  createId?: () => string;
}

function emptyGlobalGenerationConfig(): GlobalGenerationConfig {
  return GlobalGenerationConfigSchema.parse({
    id: GLOBAL_GENERATION_CONFIG_ID,
    revision: 0,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    providerId: null,
    chatPresetId: null,
    textPresetId: null,
    contextPresetId: null,
    instructPresetId: null,
    systemPresetId: null,
    selectionNotice: null,
  });
}

function createGlobalGenerationConfigRepository(database: TavernDatabase): GlobalGenerationConfigRepository {
  const table = database.sqlite.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'global_generation_config'",
  ).get();
  if (table === undefined) {
    const fallback = emptyGlobalGenerationConfig();
    return {
      get: () => structuredClone(fallback),
      update: () => ({ ok: false, reason: 'not_found' }),
      clearProvider: () => structuredClone(fallback),
      clearPreset: () => structuredClone(fallback),
    };
  }
  const base = createRepository(database, {
    table: entityTable(globalGenerationConfigurations),
    schema: GlobalGenerationConfigSchema,
    toRow: (value) => baseRow(value),
  });
  const get = () => base.get(GLOBAL_GENERATION_CONFIG_ID) ?? emptyGlobalGenerationConfig();
  return {
    get,
    update(expectedRevision, patch) {
      return base.update(GLOBAL_GENERATION_CONFIG_ID, expectedRevision, { ...patch, selectionNotice: null });
    },
    clearProvider(providerId) {
      const current = get();
      if (current.providerId !== providerId) return current;
      const result = base.update(current.id, current.revision, {
        providerId: null,
        selectionNotice: { kind: 'provider', deletedId: providerId, createdAt: new Date().toISOString() },
      });
      if (!result.ok) throw new Error('global_generation_config_conflict');
      return result.value;
    },
    clearPreset(presetId) {
      const current = get();
      const patch = Object.fromEntries(
        (['chatPresetId', 'textPresetId', 'contextPresetId', 'instructPresetId', 'systemPresetId'] as const)
          .filter((key) => current[key] === presetId)
          .map((key) => [key, null]),
      );
      if (Object.keys(patch).length === 0) return current;
      const result = base.update(current.id, current.revision, {
        ...patch,
        selectionNotice: { kind: 'preset', deletedId: presetId, createdAt: new Date().toISOString() },
      });
      if (!result.ok) throw new Error('global_generation_config_conflict');
      return result.value;
    },
  };
}

export function createRepositories(database: TavernDatabase, options: CreateRepositoriesOptions): Repositories {
  const charactersRepository = createRepository(database, {
    table: entityTable(characters), schema: CharacterSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }),
  });
  const messagesRepository = createMessageRepository(database);
  const messageVariantsRepository = createMessageVariantRepository(database);
  const baseConversations = createRepository(database, {
    table: entityTable(conversations), schema: ConversationSchema, toRow: (value) => ({
      ...baseRow(value),
      characterId: value.characterId,
      personaId: value.personaId,
      sceneId: value.sceneId ?? null,
      title: value.title,
    }), syncRelationships: syncConversationWorldbooks,
  });
  const createId = options.createId ?? randomUUID;
  const conversationsRepository: ConversationRepository = {
    ...baseConversations,
    createWithGreeting(input) {
      return database.transaction(() => {
        const character = charactersRepository.get(input.characterId);
        if (character === undefined) throw new Error('character_not_found');
        const conversation = baseConversations.create(input);
        if (character.firstMessage === '') return conversation;
        const message = messagesRepository.create({
          id: createId(), conversationId: conversation.id, role: 'assistant',
          content: character.firstMessage, activeVariantId: null,
        });
        const variants = [character.firstMessage, ...character.alternateGreetings].map((content, ordinal) => (
          messageVariantsRepository.create({
            id: createId(), messageId: message.id, ordinal, content, status: 'completed', finishReason: 'stop',
          })
        ));
        const activated = messagesRepository.update(message.id, message.revision, { activeVariantId: variants[0]!.id });
        if (!activated.ok) throw new Error('greeting_activation_failed');
        return conversation;
      });
    },
  };
  const globalGenerationConfig = createGlobalGenerationConfigRepository(database);
  return {
    installedScenes: createRepository(database, {
      table: entityTable(installedScenes),
      schema: InstalledSceneSchema,
      toRow: (value) => ({
        ...baseRow(value), slug: value.slug, version: value.version, archiveDigest: value.archiveDigest,
      }),
    }),
    characters: charactersRepository,
    personas: createPersonaRepository(database),
    worldbooks: createWorldbookRepository(database),
    worldbookEntries: createWorldbookEntryRepository(database),
    presets: createRepository(database, { table: entityTable(presets), schema: PresetSchema, toRow: (value) => ({ ...baseRow(value), name: value.name, kind: value.kind }) }),
    conversations: conversationsRepository,
    messages: messagesRepository,
    messageVariants: messageVariantsRepository,
    providerProfiles: createRepository(database, { table: entityTable(providerProfiles), schema: ProviderProfileSchema, toRow: (value) => ({ ...baseRow(value), name: value.name }) }),
    globalGenerationConfig,
    importArtifacts: createRepository(database, { table: entityTable(importArtifacts), schema: ImportArtifactSchema, toRow: (value) => ({ ...baseRow(value), kind: value.kind, entityId: value.entityId ?? null }) }),
    generationSnapshots: createGenerationSnapshotRepository(database, options.snapshotIntegrityKey),
    worldbookRuntimeStates: createWorldbookRuntimeStateRepository(database),
    conversationSceneStates: createConversationSceneStateRepository(database),
    sceneStateTransitions: createSceneStateTransitionRepository(database),
    avatarAssets: createAvatarAssetRepository(database),
    extensionAssets: createExtensionAssetRepository(database),
    extensionStates: createExtensionStateRepository(database),
    extensionTrustGrants: createExtensionTrustGrantRepository(database),
    extensionRemoteResources: createExtensionRemoteResourceRepository(database),
    extensionAuditEvents: createExtensionAuditEventRepository(database),
  };
}
