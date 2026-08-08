import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Repositories } from '../db/repositories.js';

interface Body {
  revision?: unknown;
  expectedRevision?: unknown;
  patch?: unknown;
  [key: string]: unknown;
}

const revisionFrom = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
  ? value
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;

export function registerMessageRoutes(app: FastifyInstance, repositories: Repositories): void {
  const update = async (
    request: FastifyRequest<{ Params: { id: string }; Body: Body }>,
    reply: FastifyReply,
  ) => {
    const revision = revisionFrom(request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const patch = request.body.patch ?? Object.fromEntries(
      Object.entries(request.body).filter(([key]) => key !== 'revision' && key !== 'expectedRevision'),
    );
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    try {
      const result = repositories.messages.update(request.params.id, revision, patch);
      if (result.ok) return reply.send(result.value);
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  };
  app.patch<{ Params: { id: string }; Body: Body }>('/api/messages/:id', update);
  app.put<{ Params: { id: string }; Body: Body }>('/api/messages/:id', update);
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: Body }>('/api/messages/:id', async (request, reply) => {
    const revision = revisionFrom(request.query.revision ?? request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    try {
      const result = repositories.messages.delete(request.params.id, revision);
      if (result.ok) return reply.status(204).send();
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(409).send({ error: 'constraint_conflict' });
    }
  });
}
