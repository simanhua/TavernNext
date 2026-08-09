import type { FastifyInstance } from 'fastify';
import { RelationshipLimitError, type Repositories } from '../db/repositories.js';
import type { GenerationService } from '../services/generation-service.js';
import { registerCrudRoutes } from './crud.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  repositories: Repositories,
  generations: GenerationService,
): void {
  registerCrudRoutes(app, '/api/conversations', repositories.conversations, (conversation) => {
    const { compatibility: ignoredCompatibility, ...safe } = conversation;
    void ignoredCompatibility;
    return safe;
  }, (conversation) => generations.isConversationActive(conversation.id) ? 'generation_active' : undefined,
  (input) => repositories.conversations.createWithGreeting(input));
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
            return safeVariant;
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
          return { ...safeMessage, ...(speakerLabel === undefined ? {} : { speakerLabel }), variants };
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
