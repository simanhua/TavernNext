import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CreateInput, Repository } from '../db/repositories.js';

interface MutableEntity {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface IdParameters {
  id: string;
}

interface RevisionBody {
  revision?: unknown;
  expectedRevision?: unknown;
  patch?: unknown;
  [key: string]: unknown;
}

function revisionFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function registerCrudRoutes<T extends MutableEntity>(
  app: FastifyInstance,
  path: string,
  repository: Repository<T>,
  serialize: (value: T) => unknown = (value) => value,
  mutationGuard?: (value: T) => string | undefined,
  createValue: (input: CreateInput<T>) => T = (input) => repository.create(input),
): void {
  app.get(path, async () => repository.list().map(serialize));
  app.get<{ Params: IdParameters }>(`${path}/:id`, async (request, reply) => {
    const value = repository.get(request.params.id);
    return value === undefined ? reply.status(404).send({ error: 'not_found' }) : serialize(value);
  });
  app.post<{ Body: unknown }>(path, async (request, reply) => {
    try {
      return reply.status(201).send(serialize(createValue(request.body as CreateInput<T>)));
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });

  const update = async (request: FastifyRequest<{ Params: IdParameters; Body: RevisionBody }>, reply: FastifyReply) => {
    const current = repository.get(request.params.id);
    const blocked = current === undefined ? undefined : mutationGuard?.(current);
    if (blocked !== undefined) return reply.status(409).send({ error: blocked });
    const revision = revisionFrom(request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const patch = request.body.patch ?? Object.fromEntries(
      Object.entries(request.body).filter(([key]) => key !== 'revision' && key !== 'expectedRevision'),
    );
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    try {
      const result = repository.update(request.params.id, revision, patch as Partial<CreateInput<T>>);
      if (result.ok) return reply.send(serialize(result.value));
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  };
  app.patch<{ Params: IdParameters; Body: RevisionBody }>(`${path}/:id`, update);
  app.put<{ Params: IdParameters; Body: RevisionBody }>(`${path}/:id`, update);

  app.delete<{ Params: IdParameters; Querystring: { revision?: string }; Body: RevisionBody }>(`${path}/:id`, async (request, reply) => {
    const current = repository.get(request.params.id);
    const blocked = current === undefined ? undefined : mutationGuard?.(current);
    if (blocked !== undefined) return reply.status(409).send({ error: blocked });
    const revision = revisionFrom(request.query.revision ?? request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    try {
      const result = repository.delete(request.params.id, revision);
      if (result.ok) return reply.status(204).send();
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(409).send({ error: 'constraint_conflict' });
    }
  });
}
