import { randomUUID } from 'node:crypto';
import { WorldbookEntrySchema, WorldbookSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TavernDatabase } from '../db/client.js';
import { MAX_ENTRIES_PER_WORLDBOOK, RelationshipLimitError, type Repositories } from '../db/repositories.js';
import { worldbookDetail, worldbookEntryDetail, worldbookSummary } from './manager-dtos.js';

const MAX_MANAGER_ROWS = 512;
export const BookEditableSchema = WorldbookSchema.pick({
  name: true,
  description: true,
  enabled: true,
  scanDepth: true,
  tokenBudget: true,
  recursiveScanning: true,
  isGlobal: true,
}).strict();
const BookCreateSchema = BookEditableSchema.extend({ id: WorldbookSchema.shape.id.optional() }).strict();
export const BookPatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: BookEditableSchema.partial().strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();
export const EntryEditableSchema = WorldbookEntrySchema.pick({
  keys: true,
  secondaryKeys: true,
  useRegex: true,
  selective: true,
  selectiveLogic: true,
  constant: true,
  vectorized: true,
  probability: true,
  useProbability: true,
  group: true,
  groupWeight: true,
  groupOverride: true,
  priority: true,
  content: true,
  enabled: true,
  position: true,
  order: true,
  depth: true,
  role: true,
  ignoreBudget: true,
  scanDepth: true,
  caseSensitive: true,
  matchWholeWords: true,
  useGroupScoring: true,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: true,
  sticky: true,
  cooldown: true,
  delay: true,
  characterFilter: true,
  personaFilter: true,
  matchPersonaDescription: true,
  matchCharacterDescription: true,
  matchCharacterPersonality: true,
  matchCharacterDepthPrompt: true,
  matchScenario: true,
  matchCreatorNotes: true,
  comment: true,
  displayName: true,
  addMemo: true,
  displayIndex: true,
  outletName: true,
  automationId: true,
  triggers: true,
}).strict();
export const EntryPatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: EntryEditableSchema.partial().strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();
export const ReorderSchema = z.object({
  entries: z.array(z.object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    order: z.number().int(),
  }).strict()).max(MAX_ENTRIES_PER_WORLDBOOK),
}).strict();

export function explicitPatchFields<T extends Record<string, unknown>>(raw: unknown, parsed: T): Partial<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.keys(raw).flatMap((key) => (
    Object.prototype.hasOwnProperty.call(parsed, key) ? [[key, parsed[key]]] : []
  ))) as Partial<T>;
}

export function rawPatch(body: unknown): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'patch' in body
    ? (body as { patch: unknown }).patch
    : undefined;
}

function revisionFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

class WorldbookDeleteResultError extends Error {
  constructor(readonly reason: 'not_found' | 'conflict') {
    super(reason);
    this.name = 'WorldbookDeleteResultError';
  }
}

export function registerWorldbookRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
): void {
  app.get('/api/worldbooks', async (_request, reply) => {
    const rows = repositories.worldbooks.listShared(MAX_MANAGER_ROWS + 1);
    if (rows.length > MAX_MANAGER_ROWS) return reply.status(422).send({ error: 'manager_list_limit' });
    try {
      return rows.map((worldbook) => worldbookSummary(
        worldbook,
        repositories.worldbookEntries.listByWorldbookId(worldbook.id).length,
      ));
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>('/api/worldbooks/:id', async (request, reply) => {
    if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const value = repositories.worldbooks.get(request.params.id);
    if (value === undefined) return reply.status(404).send({ error: 'not_found' });
    try {
      return worldbookDetail(value, repositories.worldbookEntries.listByWorldbookId(value.id));
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      throw error;
    }
  });
  app.post<{ Body: unknown }>('/api/worldbooks', async (request, reply) => {
    const parsed = BookCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const value = repositories.worldbooks.create({ ...parsed.data, id: parsed.data.id ?? randomUUID(), extensions: {} });
      return reply.status(201).send(worldbookDetail(value, []));
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/worldbooks/:id', async (request, reply) => {
    if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const parsed = BookPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const result = repositories.worldbooks.update(
        request.params.id,
        parsed.data.revision,
        explicitPatchFields(rawPatch(request.body), parsed.data.patch),
      );
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.send(worldbookDetail(result.value, repositories.worldbookEntries.listByWorldbookId(result.value.id)));
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: unknown }>(
    '/api/worldbooks/:id',
    async (request, reply) => {
      const bodyRevision = typeof request.body === 'object' && request.body !== null && 'revision' in request.body
        ? (request.body as { revision?: unknown }).revision
        : undefined;
      const revision = revisionFrom(request.query.revision ?? bodyRevision);
      if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
      try {
        database.transaction(() => {
          if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
            throw new Error('constraint_conflict');
          }
          if (repositories.worldbooks.hasExternalReferences(request.params.id)) {
            throw new Error('constraint_conflict');
          }
          repositories.worldbookEntries.deleteByWorldbookId(request.params.id);
          const deletion = repositories.worldbooks.delete(request.params.id, revision);
          if (!deletion.ok) throw new WorldbookDeleteResultError(deletion.reason);
        });
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof WorldbookDeleteResultError) {
          return reply.status(error.reason === 'not_found' ? 404 : 409).send({ error: error.reason });
        }
        return reply.status(409).send({ error: 'constraint_conflict' });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>('/api/worldbooks/:id/entries', async (request, reply) => {
    if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const parsed = EntryEditableSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    if (repositories.worldbooks.get(request.params.id) === undefined) return reply.status(404).send({ error: 'not_found' });
    try {
      const existing = repositories.worldbookEntries.listByWorldbookId(request.params.id);
      if (existing.length >= MAX_ENTRIES_PER_WORLDBOOK) return reply.status(422).send({ error: 'worldbook_entry_relation_limit' });
      const sourceOrdinal = existing.reduce((maximum, entry) => Math.max(maximum, entry.sourceOrdinal ?? -1), -1) + 1;
      const value = repositories.worldbookEntries.create({
        ...parsed.data,
        id: randomUUID(),
        worldbookId: request.params.id,
        sourceOrdinal,
      });
      return reply.status(201).send(worldbookEntryDetail(value));
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.patch<{ Params: { id: string; entryId: string }; Body: unknown }>(
    '/api/worldbooks/:id/entries/:entryId',
    async (request, reply) => {
      if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const parsed = EntryPatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.worldbookEntries.get(request.params.entryId);
      if (current === undefined || current.worldbookId !== request.params.id) return reply.status(404).send({ error: 'not_found' });
      try {
        const result = repositories.worldbookEntries.update(
          current.id,
          parsed.data.revision,
          explicitPatchFields(rawPatch(request.body), parsed.data.patch),
        );
        if (result.ok) return reply.send(worldbookEntryDetail(result.value));
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(400).send({ error: 'invalid_request' });
      }
    },
  );
  app.delete<{ Params: { id: string; entryId: string }; Querystring: { revision?: string }; Body: unknown }>(
    '/api/worldbooks/:id/entries/:entryId',
    async (request, reply) => {
      if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const current = repositories.worldbookEntries.get(request.params.entryId);
      if (current === undefined || current.worldbookId !== request.params.id) return reply.status(404).send({ error: 'not_found' });
      const bodyRevision = typeof request.body === 'object' && request.body !== null && 'revision' in request.body
        ? (request.body as { revision?: unknown }).revision
        : undefined;
      const revision = revisionFrom(request.query.revision ?? bodyRevision);
      if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
      const result = repositories.worldbookEntries.delete(current.id, revision);
      if (result.ok) return reply.status(204).send();
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    },
  );
  app.put<{ Params: { id: string }; Body: unknown }>('/api/worldbooks/:id/entries/order', async (request, reply) => {
    if (repositories.saveWorldbooks.getByWorldbookId(request.params.id) !== undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const parsed = ReorderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    if (repositories.worldbooks.get(request.params.id) === undefined) return reply.status(404).send({ error: 'not_found' });
    let current;
    try {
      current = repositories.worldbookEntries.listByWorldbookId(request.params.id);
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      throw error;
    }
    const requestedIds = new Set(parsed.data.entries.map((entry) => entry.id));
    if (requestedIds.size !== parsed.data.entries.length
      || current.length !== parsed.data.entries.length
      || current.some((entry) => !requestedIds.has(entry.id))) {
      return reply.status(400).send({ error: 'invalid_entry_order' });
    }
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    if (parsed.data.entries.some((entry) => currentById.get(entry.id)?.revision !== entry.revision)) {
      return reply.status(409).send({ error: 'conflict' });
    }
    try {
      database.transaction(() => {
        for (const entry of parsed.data.entries) {
          const result = repositories.worldbookEntries.update(entry.id, entry.revision, { order: entry.order });
          if (!result.ok) throw new Error(result.reason);
        }
      });
      return reply.send(worldbookDetail(
        repositories.worldbooks.get(request.params.id)!,
        repositories.worldbookEntries.listByWorldbookId(request.params.id),
      ).entries);
    } catch {
      return reply.status(409).send({ error: 'conflict' });
    }
  });
}
