import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import {
  executableChatPresetSettings,
  SaveAgentConfigurationError,
  saveAgentConfigurationFields,
} from '../services/save-agent-configuration-service.js';

const PatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({
    name: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0),
}).strict();
const ReplaceSchema = z.object({
  revision: z.number().int().nonnegative(),
  presetId: z.string().uuid(),
}).strict();
const SyncSchema = z.object({ revision: z.number().int().nonnegative() }).strict();

function configurationError(error: unknown, reply: FastifyReply) {
  if (error instanceof SaveAgentConfigurationError) {
    return reply.status(error.code === 'not_found' ? 404 : 400).send({ error: error.code });
  }
  return reply.status(400).send({ error: 'invalid_preset' });
}

export function registerSaveAgentConfigurationRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get<{ Params: { id: string } }>('/api/conversations/:id/agent-configuration', async (request, reply) => {
    if (repositories.conversations.get(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const configuration = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
    return configuration ?? reply.status(404).send({ error: 'not_found' });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/agent-configuration',
    async (request, reply) => {
      const parsed = PatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      try {
        const result = repositories.saveAgentConfigurations.update(current.id, parsed.data.revision, {
          ...parsed.data.patch,
          ...(parsed.data.patch.settings === undefined
            ? {}
            : { settings: executableChatPresetSettings(parsed.data.patch.settings) }),
        });
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(400).send({ error: 'invalid_preset' });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/agent-configuration/replace',
    async (request, reply) => {
      const parsed = ReplaceSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      try {
        const result = repositories.saveAgentConfigurations.update(
          current.id,
          parsed.data.revision,
          saveAgentConfigurationFields(repositories, parsed.data.presetId),
        );
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch (error) {
        return configurationError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/agent-configuration/sync',
    async (request, reply) => {
      const parsed = SyncSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      const current = repositories.saveAgentConfigurations.getByConversationId(request.params.id);
      if (current === undefined) return reply.status(404).send({ error: 'not_found' });
      if (current.sourcePresetId === null) return reply.status(400).send({ error: 'preset_not_configured' });
      try {
        const result = repositories.saveAgentConfigurations.update(
          current.id,
          parsed.data.revision,
          saveAgentConfigurationFields(repositories, current.sourcePresetId),
        );
        if (result.ok) return reply.send(result.value);
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch (error) {
        return configurationError(error, reply);
      }
    },
  );
}
