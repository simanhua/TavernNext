import { GlobalGenerationSelectionSchema, PresetKindSchema } from '@tavernnext/domain';
import { attachedExtensionOverview } from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import {
  resolveActivePresetExtensionResources,
  resolveActiveResourceContext,
} from '../services/active-extension-resources.js';

const PatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({
    providerId: GlobalGenerationSelectionSchema.shape.providerId.optional(),
    chatPresetId: GlobalGenerationSelectionSchema.shape.chatPresetId.optional(),
    textPresetId: z.null().optional(),
    contextPresetId: z.null().optional(),
    instructPresetId: z.null().optional(),
    systemPresetId: z.null().optional(),
  }).strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();
const ActiveResourceContextQuerySchema = z.object({ conversationId: z.string().uuid().optional() }).strict();

const presetKinds = {
  chatPresetId: 'chat',
} as const satisfies Record<string, z.infer<typeof PresetKindSchema>>;

export function registerGlobalGenerationConfigRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get('/api/settings/generation', async () => repositories.globalGenerationConfig.get());
  app.get<{ Querystring: unknown }>('/api/settings/generation/active-resource-context', async (request, reply) => {
    const parsed = ActiveResourceContextQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    return resolveActiveResourceContext(repositories, parsed.data.conversationId);
  });
  app.get('/api/settings/generation/active-extension-resources', async () => {
    const active = resolveActivePresetExtensionResources(repositories);
    return {
      mode: active.mode,
      primaryPreset: active.primaryPreset === null ? null : {
        id: active.primaryPreset.id,
        revision: active.primaryPreset.revision,
        name: active.primaryPreset.name,
        kind: active.primaryPreset.kind,
      },
      attachedExtensions: active.primaryPreset === null
        ? attachedExtensionOverview([], {})
        : attachedExtensionOverview(active.assets, active.primaryPreset.extensions),
    };
  });
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
    if (result.ok) return reply.send(result.value);
    return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
  });
}
