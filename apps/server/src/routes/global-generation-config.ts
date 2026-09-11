import { GlobalGenerationSelectionSchema, PresetKindSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';

const PatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({
    providerId: GlobalGenerationSelectionSchema.shape.providerId.optional(),
    chatPresetId: GlobalGenerationSelectionSchema.shape.chatPresetId.optional(),
  }).strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();

const presetKinds = {
  chatPresetId: 'chat',
} as const satisfies Record<string, z.infer<typeof PresetKindSchema>>;

export function registerGlobalGenerationConfigRoutes(app: FastifyInstance, repositories: Repositories): void {
  const publicSelection = (value: ReturnType<Repositories['globalGenerationConfig']['get']>) => ({
    revision: value.revision, providerId: value.providerId, chatPresetId: value.chatPresetId, selectionNotice: value.selectionNotice,
  });
  app.get('/api/settings/generation', async () => publicSelection(repositories.globalGenerationConfig.get()));
  app.patch<{ Body: unknown }>('/api/settings/generation', async (request, reply) => {
    const parsed = PatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const { patch } = parsed.data;
    const current = repositories.globalGenerationConfig.get();
    const candidate = { ...current, ...patch };
    const provider = candidate.providerId === null ? undefined : repositories.providerProfiles.get(candidate.providerId);
    if (candidate.providerId !== null && provider === undefined) return reply.status(400).send({ error: 'invalid_selection' });
    if (provider !== undefined && !provider.toolCalls) {
      return reply.status(400).send({ error: 'model_not_agent_capable' });
    }
    for (const [key, kind] of Object.entries(presetKinds) as Array<[
      keyof typeof presetKinds,
      z.infer<typeof PresetKindSchema>,
    ]>) {
      const id = patch[key];
      if (id === undefined || id === null) continue;
      if (repositories.presets.get(id)?.kind !== kind) return reply.status(400).send({ error: 'invalid_selection' });
    }
    const result = repositories.globalGenerationConfig.update(parsed.data.revision, patch);
    if (result.ok) return reply.send(publicSelection(result.value));
    return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
  });
}
