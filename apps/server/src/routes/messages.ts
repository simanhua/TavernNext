import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { roleplayDocumentFromMarkdown } from '@tavernnext/domain';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import type { SaveAgentRuntime } from '../services/save-agent-runtime.js';
import { SceneServiceError, type SceneService } from '../scenes/scene-service.js';

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
  generations: SaveAgentRuntime,
  scenes: SceneService,
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
          const updatedVariant = repositories.messageVariants.update(active.id, active.revision, {
            content,
            document: roleplayDocumentFromMarkdown(content),
          });
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
    try {
      const result = database.transaction(() => {
        scenes.switchVariantState(message, variant);
        return repositories.messages.update(message.id, revision, { activeVariantId: variant.id });
      });
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      const { compatibility: ignoredCompatibility, ...safe } = result.value;
      void ignoredCompatibility;
      return reply.send(safe);
    } catch (error) {
      if (error instanceof SceneServiceError) return reply.status(error.statusCode).send({ error: error.code });
      return reply.status(409).send({ error: 'constraint_conflict' });
    }
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: Body }>('/api/messages/:id', async (request, reply) => {
    const revision = revisionFrom(request.query.revision ?? request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const current = repositories.messages.get(request.params.id);
    if (current !== undefined && generations.isConversationActive(current.conversationId)) {
      return reply.status(409).send({ error: 'generation_active' });
    }
    try {
      const variants = current === undefined ? [] : repositories.messageVariants.listByMessageId(current.id);
      const result = database.transaction(() => {
        if (current !== undefined) scenes.deleteMessageState(current);
        const deletion = repositories.messages.delete(request.params.id, revision);
        if (deletion.ok) {
          for (const variant of variants) repositories.extensionStates.deleteByScope('message-variant', variant.id);
        }
        return deletion;
      });
      if (result.ok) return reply.status(204).send();
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(409).send({ error: 'constraint_conflict' });
    }
  });
}
