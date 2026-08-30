import type { FastifyInstance } from 'fastify';
import { roleplayDocumentPlainText } from '@tavernnext/domain';
import type { TavernDatabase } from '../db/client.js';
import { RelationshipLimitError, type Repositories } from '../db/repositories.js';
import type { SaveAgentRuntime } from '../services/save-agent-runtime.js';
import { registerCrudRoutes } from './crud.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  generations: SaveAgentRuntime,
): void {
  registerCrudRoutes(app, '/api/conversations', repositories.conversations, (conversation) => {
    const { compatibility: ignoredCompatibility, ...safe } = conversation;
    void ignoredCompatibility;
    return safe;
  }, (conversation) => generations.isConversationActive(conversation.id) ? 'generation_active' : undefined,
  (input) => database.transaction(() => {
    const conversation = repositories.conversations.createWithGreeting(input);
    return conversation;
  }),
  (id, revision) => database.transaction(() => {
    const conversation = repositories.conversations.get(id);
    const internalPersona = conversation === undefined
      ? undefined
      : repositories.personas.get(conversation.personaId);
    const variants = repositories.messageVariants.listByConversationId(id);
    const result = repositories.conversations.delete(id, revision);
    if (result.ok) {
      repositories.extensionStates.deleteByScope('conversation', id);
      for (const variant of variants) repositories.extensionStates.deleteByScope('message-variant', variant.id);
      if (internalPersona?.sceneInternal
        && !repositories.conversations.list(4_096).some((item) => item.personaId === internalPersona.id)) {
        const deletedPersona = repositories.personas.delete(internalPersona.id, internalPersona.revision);
        if (!deletedPersona.ok && deletedPersona.reason !== 'not_found') throw new Error(deletedPersona.reason);
      }
    }
    return result;
  }));
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
