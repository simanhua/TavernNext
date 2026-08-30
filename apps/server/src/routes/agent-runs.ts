import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';

export function registerAgentRunRoutes(app: FastifyInstance, repositories: Repositories): void {
  const enabled = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  app.get<{ Querystring: { conversationId?: string } }>('/api/development/agent-runs', async (request, reply) => {
    if (!enabled) return reply.status(404).send({ error: 'not_found' });
    const conversationId = request.query.conversationId;
    if (typeof conversationId !== 'string' || conversationId === '') {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    if (repositories.conversations.get(conversationId) === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return repositories.agentRuns.listRecentByConversationId(conversationId, 100);
  });
}
