import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import { registerCrudRoutes } from './crud.js';

export function registerProviderRoutes(app: FastifyInstance, repositories: Repositories): void {
  registerCrudRoutes(app, '/api/providers', repositories.providerProfiles);
}
