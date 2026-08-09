import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';

export function registerPresetRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get('/api/presets', async () => repositories.presets.list());
}
