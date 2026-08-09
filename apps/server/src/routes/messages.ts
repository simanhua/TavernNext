import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import type { GenerationService } from '../services/generation-service.js';

interface Body {
  revision?: unknown;
  expectedRevision?: unknown;
  patch?: unknown;
  [key: string]: unknown;
}

const revisionFrom = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
  ? value
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;

export function registerMessageRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  generations: GenerationService,
): void {
  const update = async (
    request: FastifyRequest<{ Params: { id: string }; Body: Body }>,
    reply: FastifyReply,
  ) => {
    const current = repositories.messages.get(request.params.id);
    if (current !== undefined && generations.isConversationActive(current.conversationId)) {
      return reply.status(409).send({ error: 'generation_active' });
    }
    const revision = revisionFrom(request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const patch = request.body.patch ?? Object.fromEntries(
      Object.entries(request.body).filter(([key]) => key !== 'revision' && key !== 'expectedRevision'),
    );
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    if (Object.keys(patch).some((key) => key !== 'content')
      || !('content' in patch) || typeof Reflect.get(patch, 'content') !== 'string') {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const content = Reflect.get(patch, 'content') as string;
    try {
      const result = current?.role === 'assistant'
        ? database.transaction(() => {
          if (current.activeVariantId === null) throw new Error('assistant_active_variant_missing');
          const active = repositories.messageVariants.get(current.activeVariantId);
          if (active === undefined || active.messageId !== current.id) throw new Error('assistant_active_variant_invalid');
          const updatedMessage = repositories.messages.update(request.params.id, revision, { content });
          if (!updatedMessage.ok) return updatedMessage;
          const updatedVariant = repositories.messageVariants.update(active.id, active.revision, { content });
          if (!updatedVariant.ok) throw new Error(`assistant_variant_${updatedVariant.reason}`);
          return updatedMessage;
        })
        : repositories.messages.update(request.params.id, revision, { content });
      if (result.ok) {
        const { compatibility: ignoredCompatibility, ...safe } = result.value;
        void ignoredCompatibility;
        return reply.send(safe);
      }
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  };
  app.patch<{ Params: { id: string }; Body: Body }>('/api/messages/:id', update);
  app.put<{ Params: { id: string }; Body: Body }>('/api/messages/:id', update);
  app.put<{ Params: { id: string }; Body: Body }>('/api/messages/:id/active-variant', async (request, reply) => {
    const revision = revisionFrom(request.body?.revision ?? request.body?.expectedRevision);
    const variantId = request.body?.variantId;
    if (revision === undefined || typeof variantId !== 'string') {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const message = repositories.messages.get(request.params.id);
    if (message === undefined) return reply.status(404).send({ error: 'not_found' });
    if (generations.isConversationActive(message.conversationId)) {
      return reply.status(409).send({ error: 'generation_active' });
    }
    if (message.role !== 'assistant') {
      return reply.status(400).send({ error: 'variant_role_unsupported' });
    }
    const variant = repositories.messageVariants.get(variantId);
    if (variant === undefined || variant.messageId !== message.id) {
      return reply.status(409).send({ error: 'variant_ownership_conflict' });
    }
    const result = repositories.messages.update(message.id, revision, { activeVariantId: variant.id });
    if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    const { compatibility: ignoredCompatibility, ...safe } = result.value;
    void ignoredCompatibility;
    return reply.send(safe);
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: Body }>('/api/messages/:id', async (request, reply) => {
    const revision = revisionFrom(request.query.revision ?? request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const current = repositories.messages.get(request.params.id);
    if (current !== undefined && generations.isConversationActive(current.conversationId)) {
      return reply.status(409).send({ error: 'generation_active' });
    }
    try {
      const result = repositories.messages.delete(request.params.id, revision);
      if (result.ok) return reply.status(204).send();
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(409).send({ error: 'constraint_conflict' });
    }
  });
}
