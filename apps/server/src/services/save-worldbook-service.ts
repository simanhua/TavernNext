import { randomUUID } from 'node:crypto';
import type { Conversation, Worldbook, WorldbookEntry, WorldbookEntryOverride } from '@tavernnext/domain';
import type { Repositories } from '../db/repositories.js';

export interface LoadedSaveWorldbook {
  ownership: NonNullable<ReturnType<Repositories['saveWorldbooks']['getByConversationId']>>;
  worldbook: Worldbook;
  entries: WorldbookEntry[];
}

function bookInput(source: Worldbook | undefined, title: string) {
  if (source === undefined) {
    return {
      id: randomUUID(), name: `${title} Worldbook`, description: '', enabled: true,
      scanDepth: null, tokenBudget: null, recursiveScanning: false, isGlobal: false, extensions: {},
    };
  }
  const {
    id: ignoredId, revision: ignoredRevision, createdAt: ignoredCreatedAt, updatedAt: ignoredUpdatedAt,
    compatibility: ignoredCompatibility, ...copy
  } = source;
  void ignoredId; void ignoredRevision; void ignoredCreatedAt; void ignoredUpdatedAt; void ignoredCompatibility;
  return { ...structuredClone(copy), id: randomUUID(), isGlobal: false };
}

function entryInput(
  source: WorldbookEntry,
  worldbookId: string,
  override: WorldbookEntryOverride | undefined,
) {
  const {
    id: ignoredId,
    revision: ignoredRevision,
    createdAt: ignoredCreatedAt,
    updatedAt: ignoredUpdatedAt,
    worldbookId: ignoredWorldbookId,
    compatibility: ignoredCompatibility,
    ...copy
  } = source;
  void ignoredId; void ignoredRevision; void ignoredCreatedAt; void ignoredUpdatedAt; void ignoredWorldbookId; void ignoredCompatibility;
  const label = `${source.comment}\n${source.displayName}`;
  return {
    ...structuredClone(copy),
    id: randomUUID(),
    worldbookId,
    enabled: label.includes('使用额外模型更新变量开') ? false : override?.enabled ?? source.enabled,
    content: override?.content ?? source.content,
  };
}

export function createSaveWorldbook(
  repositories: Repositories,
  conversation: Conversation,
  sourceWorldbookId: string | undefined,
  entryOverrides: readonly WorldbookEntryOverride[] = [],
): LoadedSaveWorldbook {
  const existing = repositories.saveWorldbooks.getByConversationId(conversation.id);
  if (existing !== undefined) {
    const worldbook = repositories.worldbooks.get(existing.worldbookId);
    if (worldbook === undefined) throw new Error('save_worldbook_missing');
    return { ownership: existing, worldbook, entries: repositories.worldbookEntries.listByWorldbookId(worldbook.id) };
  }
  const source = sourceWorldbookId === undefined ? undefined : repositories.worldbooks.get(sourceWorldbookId);
  if (sourceWorldbookId !== undefined && source === undefined) throw new Error('source_worldbook_missing');
  const overrides = new Map(entryOverrides
    .filter((override) => override.source === 'character')
    .map((override) => [override.comment, override]));
  const worldbook = repositories.worldbooks.create(bookInput(source, conversation.title));
  const sourceEntries = source === undefined ? [] : repositories.worldbookEntries.listByWorldbookId(source.id);
  const entries = sourceEntries.map((entry) => repositories.worldbookEntries.create(
    entryInput(entry, worldbook.id, overrides.get(entry.comment)),
  ));
  const ownership = repositories.saveWorldbooks.create({
    id: randomUUID(),
    conversationId: conversation.id,
    worldbookId: worldbook.id,
    sourceWorldbookId: source?.id ?? null,
    sourceWorldbookRevision: source?.revision ?? null,
  });
  return { ownership, worldbook, entries };
}

export function loadSaveWorldbook(
  repositories: Repositories,
  conversationId: string,
): LoadedSaveWorldbook | undefined {
  const ownership = repositories.saveWorldbooks.getByConversationId(conversationId);
  if (ownership === undefined) return undefined;
  const worldbook = repositories.worldbooks.get(ownership.worldbookId);
  if (worldbook === undefined) throw new Error('save_worldbook_missing');
  return { ownership, worldbook, entries: repositories.worldbookEntries.listByWorldbookId(worldbook.id) };
}
