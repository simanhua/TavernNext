import { PersonaSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { personaDetail } from './manager-dtos.js';

const MAX_MANAGER_ROWS = 512;
const PersonaEditableSchema = PersonaSchema.pick({ name: true, description: true, isDefault: true }).strict();
const PersonaCreateSchema = PersonaEditableSchema.extend({ id: PersonaSchema.shape.id }).strict();
const PersonaPatchSchema = PersonaEditableSchema.partial().strict().refine((patch) => Object.keys(patch).length > 0);
const RevisionPatchSchema = z.object({ revision: z.number().int().nonnegative(), patch: PersonaPatchSchema }).strict();

function revisionFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function registerPersonaRoutes(app: FastifyInstance, database: TavernDatabase, repositories: Repositories): void {
  app.get('/api/personas', async (_request, reply) => {
    const rows = repositories.personas.list(MAX_MANAGER_ROWS + 1);
    if (rows.length > MAX_MANAGER_ROWS) return reply.status(422).send({ error: 'manager_list_limit' });
    return rows.map(personaDetail);
  });
  app.get<{ Params: { id: string } }>('/api/personas/:id', async (request, reply) => {
    const value = repositories.personas.get(request.params.id);
    return value === undefined ? reply.status(404).send({ error: 'not_found' }) : personaDetail(value);
  });
  app.post<{ Body: unknown }>('/api/personas', async (request, reply) => {
    const parsed = PersonaCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(201).send(personaDetail(repositories.personas.create(parsed.data)));
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/personas/:id', async (request, reply) => {
    const parsed = RevisionPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const result = repositories.personas.update(request.params.id, parsed.data.revision, parsed.data.patch);
      if (result.ok) return reply.send(personaDetail(result.value));
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: unknown }>(
    '/api/personas/:id',
    async (request, reply) => {
      const bodyRevision = typeof request.body === 'object' && request.body !== null && 'revision' in request.body
        ? (request.body as { revision?: unknown }).revision
        : undefined;
      const revision = revisionFrom(request.query.revision ?? bodyRevision);
      if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
      try {
        const result = database.transaction(() => {
          const deletion = repositories.personas.delete(request.params.id, revision);
          if (deletion.ok) repositories.avatarAssets.deleteByOwner('personas', request.params.id);
          return deletion;
        });
        if (result.ok) return reply.status(204).send();
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(409).send({ error: 'constraint_conflict' });
      }
    },
  );
}
