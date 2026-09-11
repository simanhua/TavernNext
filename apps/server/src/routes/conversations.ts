import type { FastifyInstance } from 'fastify';
import { roleplayDocumentPlainText } from '@tavernnext/domain';
import { z } from 'zod';
import type { TavernDatabase } from '../db/client.js';
import { RelationshipLimitError, type Repositories } from '../db/repositories.js';
import type { SaveAgentRuntime } from '../services/save-agent-runtime.js';
import { isSceneSave } from './save-access.js';

const RenameSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({ title: z.string().min(1) }).strict(),
}).strict();

export function registerConversationRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  generations: SaveAgentRuntime,
): void {
  const serialize = (conversation: NonNullable<ReturnType<Repositories['conversations']['get']>>) => {
    const { compatibility: ignoredCompatibility, ...safe } = conversation;
    void ignoredCompatibility;
    return safe;
  };
  app.get('/api/conversations', async () => repositories.conversations.list().filter(isSceneSave).map(serialize));
  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const value = repositories.conversations.get(request.params.id);
    return isSceneSave(value) ? serialize(value) : reply.status(404).send({ error: 'not_found' });
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id', async (request, reply) => {
    if (generations.isConversationActive(request.params.id)) return reply.status(409).send({ error: 'generation_active' });
    const parsed = RenameSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const result = repositories.conversations.update(request.params.id, parsed.data.revision, parsed.data.patch);
    return result.ok ? serialize(result.value) : reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: { revision?: number } }>(
    '/api/conversations/:id', async (request, reply) => {
      if (generations.isConversationActive(request.params.id)) return reply.status(409).send({ error: 'generation_active' });
      const revision = z.coerce.number().int().nonnegative().safeParse(request.query.revision ?? request.body?.revision);
      if (!revision.success) return reply.status(400).send({ error: 'invalid_revision' });
      try {
        const result = database.transaction(() => {
          const conversation = repositories.conversations.get(request.params.id)!;
          const internalPersona = repositories.personas.get(conversation.personaId);
          const variants = repositories.messageVariants.listByConversationId(conversation.id);
          const deleted = repositories.conversations.delete(conversation.id, revision.data);
          if (deleted.ok) {
            repositories.extensionStates.deleteByScope('conversation', conversation.id);
            for (const variant of variants) repositories.extensionStates.deleteByScope('message-variant', variant.id);
            if (internalPersona?.sceneInternal
              && !repositories.conversations.list(4_096).some((item) => item.personaId === internalPersona.id)) {
              const deletedPersona = repositories.personas.delete(internalPersona.id, internalPersona.revision);
              if (!deletedPersona.ok && deletedPersona.reason !== 'not_found') throw new Error(deletedPersona.reason);
            }
          }
          return deleted;
        });
        return result.ok ? reply.status(204).send() : reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(409).send({ error: 'constraint_conflict' });
      }
    },
  );
  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request, reply) => {
    const conversation = repositories.conversations.get(request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not_found' });
    try {
      const variantsByMessage = new Map<string, ReturnType<typeof repositories.messageVariants.listByConversationId>>();
      for (const variant of repositories.messageVariants.listByConversationId(conversation.id)) {
        const variants = variantsByMessage.get(variant.messageId) ?? [];
        variants.push(variant);
        variantsByMessage.set(variant.messageId, variants);
      }
      const messages = repositories.messages.listByConversationId(conversation.id)
        .map((message) => {
          const { compatibility: ignoredMessageCompatibility, ...safeMessage } = message;
          void ignoredMessageCompatibility;
          const variants = (variantsByMessage.get(message.id) ?? []).map((variant) => {
            const { compatibility: ignoredVariantCompatibility, ...safeVariant } = variant;
            void ignoredVariantCompatibility;
            return { ...safeVariant, content: roleplayDocumentPlainText(variant.document) };
          });
          const rawPayload = message.compatibility?.rawPayload;
          const imported = typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
            ? rawPayload as Record<string, unknown>
            : undefined;
          const speakerLabel = message.role !== 'system'
            ? undefined
            : imported?.isSystem === false
              ? 'Narrator'
              : 'System';
          const activeVariant = message.activeVariantId === null
            ? undefined
            : variants.find((variant) => variant.id === message.activeVariantId);
          const content = message.role === 'assistant'
            ? activeVariant?.content ?? variants[0]?.content ?? ''
            : message.content;
          return { ...safeMessage, content, ...(speakerLabel === undefined ? {} : { speakerLabel }), variants };
        });
      const { compatibility: ignoredConversationCompatibility, ...safeConversation } = conversation;
      void ignoredConversationCompatibility;
      return { conversation: safeConversation, messages };
    } catch (error) {
      if (error instanceof RelationshipLimitError) return reply.status(422).send({ error: error.code });
      throw error;
    }
  });
}
