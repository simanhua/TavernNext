import type { Conversation } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';

/** Public conversation resources belong to installed Scenes. Historical rows stay in storage. */
export function isSceneSave(value: Conversation | undefined): value is Conversation {
  return value?.sceneId !== undefined;
}

export function registerSaveAccessGuard(app: FastifyInstance, repositories: Repositories): void {
  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    const params = request.params as { id?: string };
    let conversationId: string | undefined;
    let saveResource = false;
    if (route.startsWith('/api/conversations/:id')) {
      saveResource = true;
      conversationId = params.id;
    } else if (route.startsWith('/api/messages/:id')) {
      saveResource = true;
      conversationId = params.id === undefined ? undefined : repositories.messages.get(params.id)?.conversationId;
    } else if (route.startsWith('/api/memories/:id')) {
      saveResource = true;
      conversationId = params.id === undefined ? undefined : repositories.saveMemories.get(params.id)?.conversationId;
    } else if (route.startsWith('/api/memory-jobs/:id')) {
      saveResource = true;
      conversationId = params.id === undefined ? undefined : repositories.memoryJobs.get(params.id)?.conversationId;
    } else if (route === '/api/development/agent-runs') {
      const query = request.query as { conversationId?: string };
      saveResource = typeof query.conversationId === 'string' && query.conversationId !== '';
      conversationId = query.conversationId;
    }
    if (saveResource && !isSceneSave(conversationId === undefined ? undefined : repositories.conversations.get(conversationId))) {
      return reply.status(404).send({ error: 'not_found' });
    }
  });
}
