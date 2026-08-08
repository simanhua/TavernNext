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
});
export const worldbookEntries = sqliteTable('worldbook_entries', {
  ...entityColumns,
  worldbookId: text('worldbook_id').notNull().references(() => worldbooks.id),
}, (table) => [index('worldbook_entries_worldbook_id_idx').on(table.worldbookId)]);
export const presets = sqliteTable('presets', {
  ...entityColumns,
  name: text('name').notNull(),
  kind: text('kind').notNull(),
});
export const conversations = sqliteTable('conversations', {
  ...entityColumns,
  characterId: text('character_id').notNull().references(() => characters.id),
  personaId: text('persona_id').notNull().references(() => personas.id),
  presetId: text('preset_id').references(() => presets.id),
  title: text('title').notNull(),
}, (table) => [
  index('conversations_character_id_idx').on(table.characterId),
  index('conversations_persona_id_idx').on(table.personaId),
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
  status: text('status').notNull(),
}, (table) => [index('message_variants_message_id_idx').on(table.messageId)]);
export const messages = sqliteTable('messages', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  activeVariantId: text('active_variant_id').references(() => messageVariants.id),
  role: text('role').notNull(),
}, (table) => [
  index('messages_conversation_id_idx').on(table.conversationId),
  index('messages_active_variant_id_idx').on(table.activeVariantId),
]);
export const providerProfiles = sqliteTable('provider_profiles', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const importArtifacts = sqliteTable('import_artifacts', {
  ...entityColumns,
  kind: text('kind').notNull(),
  entityId: text('entity_id'),
});
export const generationSnapshots = sqliteTable('generation_snapshots', {
  ...entityColumns,
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
}, (table) => [index('generation_snapshots_conversation_id_idx').on(table.conversationId)]);
