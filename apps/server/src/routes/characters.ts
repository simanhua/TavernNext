import { CharacterSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import { characterDetail, characterSummary } from './manager-dtos.js';

const MAX_MANAGER_ROWS = 512;
const CharacterEditableSchema = CharacterSchema.pick({
  name: true,
  description: true,
  personality: true,
  scenario: true,
  firstMessage: true,
  examples: true,
  systemPrompt: true,
  postHistoryInstructions: true,
  creatorNotes: true,
  creator: true,
  characterVersion: true,
  depthPrompt: true,
  alternateGreetings: true,
  tags: true,
  worldbookId: true,
}).strict();
const CharacterCreateSchema = CharacterEditableSchema.extend({ id: CharacterSchema.shape.id }).strict();
const CharacterPatchSchema = CharacterEditableSchema.omit({ worldbookId: true }).partial().extend({
  worldbookId: CharacterSchema.shape.worldbookId.nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0);
const RevisionPatchSchema = z.object({ revision: z.number().int().nonnegative(), patch: CharacterPatchSchema }).strict();

function revisionFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function registerCharacterRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get('/api/characters', async (_request, reply) => {
    const rows = repositories.characters.list(MAX_MANAGER_ROWS + 1);
    if (rows.length > MAX_MANAGER_ROWS) return reply.status(422).send({ error: 'manager_list_limit' });
    return rows.map(characterSummary);
  });
  app.get<{ Params: { id: string } }>('/api/characters/:id', async (request, reply) => {
    const value = repositories.characters.get(request.params.id);
    return value === undefined ? reply.status(404).send({ error: 'not_found' }) : characterDetail(value);
  });
  app.post<{ Body: unknown }>('/api/characters', async (request, reply) => {
    const parsed = CharacterCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(201).send(characterDetail(repositories.characters.create(parsed.data)));
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/characters/:id', async (request, reply) => {
    const parsed = RevisionPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const { worldbookId, ...fields } = parsed.data.patch;
      const patch = worldbookId === null
        ? { ...fields, worldbookId: undefined }
        : worldbookId === undefined ? fields : { ...fields, worldbookId };
      const result = repositories.characters.update(request.params.id, parsed.data.revision, patch);
      if (result.ok) return reply.send(characterDetail(result.value));
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: unknown }>(
    '/api/characters/:id',
    async (request, reply) => {
      const bodyRevision = typeof request.body === 'object' && request.body !== null && 'revision' in request.body
        ? (request.body as { revision?: unknown }).revision
        : undefined;
      const revision = revisionFrom(request.query.revision ?? bodyRevision);
      if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
      try {
        const result = repositories.characters.delete(request.params.id, revision);
        if (result.ok) return reply.status(204).send();
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(409).send({ error: 'constraint_conflict' });
      }
    },
  );
}
