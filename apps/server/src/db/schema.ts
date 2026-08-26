import { customType, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const jsonText = <T>() => customType<{ data: T; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value),
});

const entityColumns = {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  payload: jsonText<unknown>()('payload').notNull(),
};

export const characters = sqliteTable('characters', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const personas = sqliteTable('personas', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const worldbooks = sqliteTable('worldbooks', {
  ...entityColumns,
  name: text('name').notNull(),
  isGlobal: integer('is_global', { mode: 'boolean' }).notNull(),
}, (table) => [
  index('worldbooks_is_global_idx').on(table.isGlobal),
  index('worldbooks_global_created_id_idx').on(table.isGlobal, table.createdAt, table.id),
]);
export const worldbookEntries = sqliteTable('worldbook_entries', {
  ...entityColumns,
  worldbookId: text('worldbook_id').notNull().references(() => worldbooks.id),
}, (table) => [
  index('worldbook_entries_worldbook_id_idx').on(table.worldbookId),
  index('worldbook_entries_worldbook_created_id_idx').on(table.worldbookId, table.createdAt, table.id),
]);
export const presets = sqliteTable('presets', {
  ...entityColumns,
  name: text('name').notNull(),
  kind: text('kind').notNull(),
});
export const providerProfiles = sqliteTable('provider_profiles', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const globalGenerationConfigurations = sqliteTable('global_generation_config', {
  ...entityColumns,
});
export const installedScenes = sqliteTable('installed_scenes', {
  ...entityColumns,
  slug: text('slug').notNull().unique(),
  version: text('version').notNull(),
  archiveDigest: text('archive_digest').notNull(),
}, (table) => [index('installed_scenes_slug_idx').on(table.slug)]);
export const extensionAssets = sqliteTable('extension_assets', {
  ...entityColumns,
  ownerKind: text('owner_kind').notNull(),
  ownerId: text('owner_id').notNull(),
  kind: text('kind').notNull(),
  sourceKey: text('source_key').notNull(),
  ordinal: integer('ordinal').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
}, (table) => [
  index('extension_assets_owner_kind_id_idx').on(table.ownerKind, table.ownerId),
  index('extension_assets_owner_kind_id_kind_ordinal_idx').on(
    table.ownerKind, table.ownerId, table.kind, table.ordinal,
  ),
]);
export const extensionStates = sqliteTable('extension_states', {
  ...entityColumns,
  scope: text('scope').notNull(),
  scopeId: text('scope_id').notNull(),
}, (table) => [
  index('extension_states_scope_id_idx').on(table.scope, table.scopeId),
]);
export const extensionTrustGrants = sqliteTable('extension_trust_grants', {
  ...entityColumns,
  ownerKind: text('owner_kind').notNull(),
  ownerId: text('owner_id').notNull(),
}, (table) => [index('extension_trust_grants_owner_idx').on(table.ownerKind, table.ownerId)]);
export const extensionRemoteResources = sqliteTable('extension_remote_resources', {
  ...entityColumns,
  ownerKind: text('owner_kind').notNull(),
  ownerId: text('owner_id').notNull(),
  url: text('url').notNull(),
  sha256: text('sha256').notNull(),
}, (table) => [index('extension_remote_resources_owner_idx').on(table.ownerKind, table.ownerId)]);
export const extensionAuditEvents = sqliteTable('extension_audit_events', {
  ...entityColumns,
  ownerKind: text('owner_kind').notNull(),
  ownerId: text('owner_id').notNull(),
  event: text('event').notNull(),
}, (table) => [index('extension_audit_events_owner_idx').on(table.ownerKind, table.ownerId)]);
export const conversations = sqliteTable('conversations', {
  ...entityColumns,
  characterId: text('character_id').notNull().references(() => characters.id),
  personaId: text('persona_id').notNull().references(() => personas.id),
  sceneId: text('scene_id').references(() => installedScenes.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
}, (table) => [
  index('conversations_character_id_idx').on(table.characterId),
  index('conversations_persona_id_idx').on(table.personaId),
  index('conversations_scene_id_idx').on(table.sceneId),
]);
export const saveAgentConfigurations = sqliteTable('save_agent_configurations', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().unique().references(() => conversations.id, { onDelete: 'cascade' }),
}, (table) => [index('save_agent_configurations_conversation_id_idx').on(table.conversationId)]);
export const conversationSceneStates = sqliteTable('conversation_scene_states', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().unique().references(() => conversations.id, { onDelete: 'cascade' }),
}, (table) => [index('conversation_scene_states_conversation_id_idx').on(table.conversationId)]);
export const sceneStateTransitions = sqliteTable('scene_state_transitions', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  parentTransitionId: text('parent_transition_id'),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
}, (table) => [
  index('scene_state_transitions_conversation_idx').on(table.conversationId),
  index('scene_state_transitions_source_idx').on(table.sourceKind, table.sourceId),
]);
export const conversationWorldbooks = sqliteTable('conversation_worldbooks', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  worldbookId: text('worldbook_id').notNull().references(() => worldbooks.id),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.worldbookId] }),
  index('conversation_worldbooks_worldbook_id_idx').on(table.worldbookId),
]);
export const messageVariants = sqliteTable('message_variants', {
  ...entityColumns,
  messageId: text('message_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  status: text('status').notNull(),
}, (table) => [
  index('message_variants_message_id_idx').on(table.messageId),
  index('message_variants_message_created_id_idx').on(table.messageId, table.createdAt, table.id),
  index('message_variants_message_ordinal_created_id_idx').on(table.messageId, table.ordinal, table.createdAt, table.id),
]);
export const messages = sqliteTable('messages', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  activeVariantId: text('active_variant_id').references(() => messageVariants.id),
  role: text('role').notNull(),
}, (table) => [
  index('messages_conversation_id_idx').on(table.conversationId),
  index('messages_conversation_created_id_idx').on(table.conversationId, table.createdAt, table.id),
  index('messages_active_variant_id_idx').on(table.activeVariantId),
]);
export const importArtifacts = sqliteTable('import_artifacts', {
  ...entityColumns,
  kind: text('kind').notNull(),
  entityId: text('entity_id'),
});
export const generationSnapshots = sqliteTable('generation_snapshots', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  integrityTag: text('integrity_tag'),
}, (table) => [index('generation_snapshots_conversation_id_idx').on(table.conversationId)]);
export const worldbookRuntimeStates = sqliteTable('worldbook_runtime_states', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().unique().references(() => conversations.id, { onDelete: 'cascade' }),
}, (table) => [index('worldbook_runtime_states_conversation_id_idx').on(table.conversationId)]);
