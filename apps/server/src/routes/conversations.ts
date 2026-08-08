import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import { registerCrudRoutes } from './crud.js';

export function registerConversationRoutes(app: FastifyInstance, repositories: Repositories): void {
  registerCrudRoutes(app, '/api/conversations', repositories.conversations);
  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request, reply) => {
    const conversation = repositories.conversations.get(request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not_found' });
    const variantsByMessage = new Map<string, ReturnType<typeof repositories.messageVariants.list>>();
    for (const variant of repositories.messageVariants.list()) {
      const variants = variantsByMessage.get(variant.messageId) ?? [];
      variants.push(variant);
      variantsByMessage.set(variant.messageId, variants);
    }
    const messages = repositories.messages.list()
      .filter((message) => message.conversationId === conversation.id)
      .map((message) => ({ ...message, variants: variantsByMessage.get(message.id) ?? [] }));
    return { conversation, messages };
  });
}
