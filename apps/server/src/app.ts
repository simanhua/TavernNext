import Fastify, { type FastifyInstance } from 'fastify';

export function createApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.x-api-key'],
    },
  });

  app.get('/api/health', async () => ({ status: 'ok', app: 'TavernNext' }));

  return app;
}
