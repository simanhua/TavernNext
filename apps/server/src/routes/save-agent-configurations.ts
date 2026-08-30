import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TavernDatabase } from '../db/client.js';
import { MAX_ENTRIES_PER_WORLDBOOK, RelationshipLimitError, type Repositories } from '../db/repositories.js';
import {
  executableChatPresetSettings,
  SaveAgentConfigurationError,
  saveAgentConfigurationFields,
} from '../services/save-agent-configuration-service.js';
import { worldbookDetail, worldbookEntryDetail } from './manager-dtos.js';
import { BookPatchSchema, EntryEditableSchema, EntryPatchSchema, ReorderSchema, explicitPatchFields, rawPatch } from './worldbooks.js';

const PatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({
    name: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0),
}).strict();
const ReplaceSchema = z.object({
  revision: z.number().int().nonnegative(),
  presetId: z.string().uuid(),
}).strict();
const SyncSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
const ToggleSchema = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
}).strict();
const REQUIRED_PROMPT_IDS = new Set([
  'charDescription', 'personaDescription', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter',
]);
type RuntimeWorldbookEntryDetail = ReturnType<typeof worldbookEntryDetail> & {
  effectiveEnabled: boolean;
  activationSource: 'template' | 'save';
  saveOverrideEnabled?: boolean;
  contentOverridden: boolean;
  effectiveContent: string;
};
type RuntimeWorldbookDetail = Omit<ReturnType<typeof worldbookDetail>, 'entries'> & {
  effectiveEnabled: boolean;
  entries: RuntimeWorldbookEntryDetail[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toggledPromptSettings(
  settings: Record<string, unknown>,
  identifier: string,
  enabled: boolean,
): Record<string, unknown> | undefined {
  const prompts = Array.isArray(settings.prompts) ? settings.prompts.map((value) => {
    const prompt = record(value);
    return prompt === undefined || String(prompt.identifier ?? '') !== identifier
      ? structuredClone(value)
      : { ...structuredClone(prompt), enabled };
  }) : [];
  if (!prompts.some((value) => String(record(value)?.identifier ?? '') === identifier)) return undefined;
  const sourceGroups = Array.isArray(settings.prompt_order) ? settings.prompt_order : [];
  const groups = (sourceGroups.length === 0 ? [{ character_id: 100001, order: [] }] : sourceGroups).map((value, index) => {
    const group = record(value) ?? {};
    const sourceOrder = Array.isArray(group.order) ? group.order : [];
    let found = false;
    const order = sourceOrder.map((entry) => {
      const item = record(entry);
      if (item === undefined || String(item.identifier ?? '') !== identifier) return structuredClone(entry);
      found = true;
      return { ...structuredClone(item), enabled };
    });
    if (!found && index === 0) order.push({ identifier, enabled });
    return { ...structuredClone(group), order };
  });
  return { ...structuredClone(settings), prompts, prompt_order: groups };
}

function runtimeWorldbook(
  repositories: Repositories,
  conversationId: string,
  worldbookId: string,
) {
  const conversation = repositories.conversations.get(conversationId);
  if (conversation === undefined) return undefined;
  const character = repositories.characters.get(conversation.characterId);
  const worldbook = repositories.worldbooks.get(worldbookId);
  if (character === undefined || worldbook === undefined) return undefined;
  const saveWorldbook = repositories.saveWorldbooks.getByConversationId(conversation.id);
  return worldbook.isGlobal
    || saveWorldbook?.worldbookId === worldbook.id
    || (saveWorldbook === undefined && character.worldbookId === worldbook.id)
    || conversation.worldbookIds.includes(worldbook.id)
    ? worldbook
    : undefined;
}

function configurationError(error: unknown, reply: FastifyReply) {
  if (error instanceof SaveAgentConfigurationError) {
    return reply.status(error.code === 'not_found' ? 404 : 400).send({ error: error.code });
  }
  return reply.status(400).send({ error: 'invalid_preset' });
}

function ownedSaveWorldbook(repositories: Repositories, conversationId: string, worldbookId: string) {
  const ownership = repositories.saveWorldbooks.getByConversationId(conversationId);
  return ownership?.worldbookId === worldbookId ? repositories.worldbooks.get(worldbookId) : undefined;
}

export function registerSaveAgentConfigurationRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
): void {
  app.get<{ Params: { id: string } }>('/api/conversations/:id/agent-configuration', async (request, reply) => {
    if (repositories.conversations.get(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const configuration = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
    return configuration ?? reply.status(404).send({ error: 'not_found' });
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/runtime-references', async (request, reply) => {
    const conversation = repositories.conversations.get(request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not_found' });
    const character = repositories.characters.get(conversation.characterId);
    const configuration = repositories.saveAgentConfigurations.getByConversationId(conversation.id);
    if (character === undefined || configuration === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }

    try {
      const entryOverrides = repositories.worldbookRuntimeStates
        .getByConversationId(conversation.id)?.entryOverrides ?? [];
      const seen = new Set<string>();
      const worldbooks: Array<{
        source: 'global' | 'character' | 'conversation';
        saveOwned: boolean;
        templateLineage?: { worldbookId: string | null; revision: number | null };
        value: RuntimeWorldbookDetail;
      }> = [];
      const saveWorldbook = repositories.saveWorldbooks.getByConversationId(conversation.id);
      const add = (id: string, source: 'global' | 'character' | 'conversation', saveOwned = false): boolean => {
        if (seen.has(id)) return true;
        const value = repositories.worldbooks.get(id);
        if (value === undefined) return false;
        seen.add(id);
        const detail = worldbookDetail(value, repositories.worldbookEntries.listByWorldbookId(value.id));
        const overrides = new Map(entryOverrides
          .filter((override) => override.source === source)
          .map((override) => [override.comment, override]));
        worldbooks.push({
          source,
          saveOwned,
          ...(saveOwned ? { templateLineage: {
            worldbookId: saveWorldbook?.sourceWorldbookId ?? null,
            revision: saveWorldbook?.sourceWorldbookRevision ?? null,
          } } : {}),
          value: {
            ...detail,
            effectiveEnabled: detail.enabled,
            entries: detail.entries.map((entry) => {
              const override = overrides.get(entry.comment);
              const effectiveEnabled = detail.enabled && (override?.enabled ?? entry.enabled);
              return {
                ...entry,
                effectiveEnabled,
                activationSource: saveOwned || override !== undefined ? 'save' as const : 'template' as const,
                ...(saveOwned ? { saveOverrideEnabled: entry.enabled }
                  : override === undefined ? {} : { saveOverrideEnabled: override.enabled }),
                contentOverridden: override?.content !== undefined,
                effectiveContent: override?.content ?? entry.content,
              };
            }),
          },
        });
        return true;
      };

      for (const worldbook of repositories.worldbooks.listGlobal()) add(worldbook.id, 'global');
      const characterWorldbookId = saveWorldbook?.worldbookId ?? character.worldbookId;
      if (characterWorldbookId !== undefined && !add(characterWorldbookId, 'character', saveWorldbook !== undefined)) {
        return reply.status(404).send({ error: 'not_found' });
      }
      for (const id of conversation.worldbookIds) {
        if (!add(id, 'conversation')) return reply.status(404).send({ error: 'not_found' });
      }
      return { configuration, worldbooks };
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      throw error;
    }
  });

  app.patch<{ Params: { id: string; identifier: string }; Body: unknown }>(
    '/api/conversations/:id/runtime-references/preset-prompts/:identifier',
    async (request, reply) => {
      const parsed = ToggleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      if (REQUIRED_PROMPT_IDS.has(request.params.identifier)) {
        return reply.status(400).send({ error: 'prompt_required' });
      }
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      const settings = toggledPromptSettings(current.settings, request.params.identifier, parsed.data.enabled);
      if (settings === undefined) return reply.status(404).send({ error: 'not_found' });
      try {
        const result = repositories.saveAgentConfigurations.update(current.id, parsed.data.revision, {
          settings: executableChatPresetSettings(settings),
        });
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(400).send({ error: 'invalid_preset' });
      }
    },
  );

  app.patch<{ Params: { id: string; worldbookId: string }; Body: unknown }>(
    '/api/conversations/:id/runtime-references/worldbooks/:worldbookId',
    async (request, reply) => {
      const parsed = ToggleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = runtimeWorldbook(repositories, request.params.id, request.params.worldbookId);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      const result = repositories.worldbooks.update(current.id, parsed.data.revision, { enabled: parsed.data.enabled });
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.send(worldbookDetail(
        result.value,
        repositories.worldbookEntries.listByWorldbookId(result.value.id),
      ));
    },
  );

  app.patch<{ Params: { id: string; worldbookId: string }; Body: unknown }>(
    '/api/conversations/:id/save-worldbook/:worldbookId',
    async (request, reply) => {
      const parsed = BookPatchSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.patch.isGlobal !== undefined) {
        return reply.status(400).send({ error: 'invalid_request' });
      }
      const current = ownedSaveWorldbook(repositories, request.params.id, request.params.worldbookId);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      const result = repositories.worldbooks.update(
        current.id,
        parsed.data.revision,
        explicitPatchFields(rawPatch(request.body), parsed.data.patch),
      );
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.send(worldbookDetail(result.value, repositories.worldbookEntries.listByWorldbookId(result.value.id)));
    },
  );

  app.post<{ Params: { id: string; worldbookId: string }; Body: unknown }>(
    '/api/conversations/:id/save-worldbook/:worldbookId/entries',
    async (request, reply) => {
      const parsed = EntryEditableSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      if (ownedSaveWorldbook(repositories, request.params.id, request.params.worldbookId) === undefined) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const existing = repositories.worldbookEntries.listByWorldbookId(request.params.worldbookId);
      if (existing.length >= MAX_ENTRIES_PER_WORLDBOOK) {
        return reply.status(422).send({ error: 'worldbook_entry_relation_limit' });
      }
      const sourceOrdinal = existing.reduce((maximum, entry) => Math.max(maximum, entry.sourceOrdinal ?? -1), -1) + 1;
      const value = repositories.worldbookEntries.create({
        ...parsed.data, id: randomUUID(), worldbookId: request.params.worldbookId, sourceOrdinal,
      });
      return reply.status(201).send(worldbookEntryDetail(value));
    },
  );

  app.patch<{ Params: { id: string; worldbookId: string; entryId: string }; Body: unknown }>(
    '/api/conversations/:id/runtime-references/worldbooks/:worldbookId/entries/:entryId',
    async (request, reply) => {
      const parsed = ToggleSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      if (runtimeWorldbook(repositories, request.params.id, request.params.worldbookId) === undefined) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const current = repositories.worldbookEntries.get(request.params.entryId);
      if (current === undefined || current.worldbookId !== request.params.worldbookId) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const result = repositories.worldbookEntries.update(current.id, parsed.data.revision, { enabled: parsed.data.enabled });
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.send(worldbookEntryDetail(result.value));
    },
  );

  app.patch<{ Params: { id: string; worldbookId: string; entryId: string }; Body: unknown }>(
    '/api/conversations/:id/save-worldbook/:worldbookId/entries/:entryId',
    async (request, reply) => {
      const parsed = EntryPatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      if (ownedSaveWorldbook(repositories, request.params.id, request.params.worldbookId) === undefined) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const current = repositories.worldbookEntries.get(request.params.entryId);
      if (current === undefined || current.worldbookId !== request.params.worldbookId) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const result = repositories.worldbookEntries.update(
        current.id,
        parsed.data.revision,
        explicitPatchFields(rawPatch(request.body), parsed.data.patch),
      );
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.send(worldbookEntryDetail(result.value));
    },
  );

  app.delete<{ Params: { id: string; worldbookId: string; entryId: string }; Querystring: { revision?: string } }>(
    '/api/conversations/:id/save-worldbook/:worldbookId/entries/:entryId',
    async (request, reply) => {
      if (ownedSaveWorldbook(repositories, request.params.id, request.params.worldbookId) === undefined) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const revision = typeof request.query.revision === 'string' && /^\d+$/.test(request.query.revision)
        ? Number(request.query.revision)
        : undefined;
      if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
      const current = repositories.worldbookEntries.get(request.params.entryId);
      if (current === undefined || current.worldbookId !== request.params.worldbookId) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const result = repositories.worldbookEntries.delete(current.id, revision);
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.status(204).send();
    },
  );

  app.put<{ Params: { id: string; worldbookId: string }; Body: unknown }>(
    '/api/conversations/:id/save-worldbook/:worldbookId/entries/order',
    async (request, reply) => {
      const parsed = ReorderSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const worldbook = ownedSaveWorldbook(repositories, request.params.id, request.params.worldbookId);
      if (worldbook === undefined) return reply.status(404).send({ error: 'not_found' });
      const current = repositories.worldbookEntries.listByWorldbookId(worldbook.id);
      const byId = new Map(current.map((entry) => [entry.id, entry]));
      if (byId.size !== parsed.data.entries.length
        || parsed.data.entries.some((entry) => byId.get(entry.id)?.revision !== entry.revision)) {
        return reply.status(409).send({ error: 'conflict' });
      }
      database.transaction(() => {
        for (const entry of parsed.data.entries) {
          const result = repositories.worldbookEntries.update(entry.id, entry.revision, { order: entry.order });
          if (!result.ok) throw new Error(result.reason);
        }
      });
      return reply.send(worldbookDetail(
        worldbook,
        repositories.worldbookEntries.listByWorldbookId(worldbook.id),
      ).entries);
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/agent-configuration',
    async (request, reply) => {
      const parsed = PatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      try {
        const result = repositories.saveAgentConfigurations.update(current.id, parsed.data.revision, {
          ...parsed.data.patch,
          ...(parsed.data.patch.settings === undefined
            ? {}
            : { settings: executableChatPresetSettings(parsed.data.patch.settings) }),
        });
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(400).send({ error: 'invalid_preset' });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/agent-configuration/replace',
    async (request, reply) => {
      const parsed = ReplaceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      try {
        const result = repositories.saveAgentConfigurations.update(
          current.id,
          parsed.data.revision,
          saveAgentConfigurationFields(repositories, parsed.data.presetId),
        );
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch (error) {
        return configurationError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/agent-configuration/sync',
    async (request, reply) => {
      const parsed = SyncSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      if (current.sourcePresetId === null) return reply.status(400).send({ error: 'preset_not_configured' });
      try {
        const result = repositories.saveAgentConfigurations.update(
          current.id,
          parsed.data.revision,
          saveAgentConfigurationFields(repositories, current.sourcePresetId),
        );
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch (error) {
        return configurationError(error, reply);
      }
    },
  );
}
