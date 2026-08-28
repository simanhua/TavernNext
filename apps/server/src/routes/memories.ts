import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';

const revision = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
);

function publicEmbedding(value: ReturnType<Repositories['globalEmbeddingConfiguration']['get']>) {
  const { secretRef, ...safe } = value;
  return { ...safe, configured: secretRef !== null && value.baseUrl !== null && value.model !== null };
}

export function registerMemoryRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get<{ Params: { id: string } }>('/api/conversations/:id/memories', async (request, reply) => {
    if (repositories.conversations.get(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return {
      configuration: repositories.saveMemoryConfigurations.getByConversationId(request.params.id) ?? null,
      memories: repositories.saveMemories.listByConversationId(request.params.id),
      jobs: repositories.memoryJobs.listByConversationId(request.params.id).map(({ payload: ignoredPayload, ...job }) => {
        void ignoredPayload;
        return job;
      }),
      embedding: publicEmbedding(repositories.globalEmbeddingConfiguration.get()),
    };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/conversations/:id/memory-settings', async (request, reply) => {
    if (repositories.conversations.get(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    if (typeof request.body?.enabled !== 'boolean') return reply.status(400).send({ error: 'invalid_request' });
    const current = repositories.saveMemoryConfigurations.getByConversationId(request.params.id);
    if (current === undefined) {
      return repositories.saveMemoryConfigurations.create({
        id: randomUUID(), conversationId: request.params.id, enabled: request.body.enabled,
        disabledAt: request.body.enabled ? null : new Date().toISOString(),
      });
    }
    const expectedRevision = revision(request.body?.revision);
    if (expectedRevision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const result = repositories.saveMemoryConfigurations.update(current.id, expectedRevision, {
      enabled: request.body.enabled,
      disabledAt: request.body.enabled ? null : new Date().toISOString(),
    });
    if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    return result.value;
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/memories/:id', async (request, reply) => {
    const expectedRevision = revision(request.body?.revision);
    if (expectedRevision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const patch = Object.fromEntries(
      ['pinned', 'excluded'].flatMap((key) => typeof request.body?.[key] === 'boolean' ? [[key, request.body[key]]] : []),
    );
    if (Object.keys(patch).length === 0) return reply.status(400).send({ error: 'invalid_request' });
    const result = repositories.saveMemories.update(request.params.id, expectedRevision, patch);
    if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    return result.value;
  });

  app.delete<{ Params: { id: string }; Querystring: { revision?: string } }>('/api/memories/:id', async (request, reply) => {
    const expectedRevision = revision(request.query.revision);
    if (expectedRevision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const result = repositories.saveMemories.delete(request.params.id, expectedRevision);
    if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/memory-index/rebuild', async (request, reply) => {
    if (repositories.conversations.get(request.params.id) === undefined) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const job = repositories.memoryJobs.create({
      id: randomUUID(), conversationId: request.params.id, kind: 'rebuild-index', status: 'pending',
      attempts: 0, nextAttemptAt: null, payload: {}, lastError: null,
    });
    return reply.status(202).send(job);
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/memory-backfill', async (request, reply) => {
    const conversation = repositories.conversations.get(request.params.id);
    if (conversation === undefined) return reply.status(404).send({ error: 'not_found' });
    const messages = repositories.messages.listByConversationId(conversation.id);
    const variants = new Map(repositories.messageVariants.listByConversationId(conversation.id).map((item) => [item.id, item]));
    const existingRunIds = new Set([
      ...repositories.saveMemories.listByConversationId(conversation.id).flatMap((memory) => (
        memory.sourceAgentRunId === null ? [] : [memory.sourceAgentRunId]
      )),
      ...repositories.memoryJobs.listByConversationId(conversation.id).flatMap((job) => (
        typeof job.payload.sourceAgentRunId === 'string' ? [job.payload.sourceAgentRunId] : []
      )),
    ]);
    let created = 0;
    let skipped = 0;
    for (const run of repositories.agentRuns.listByConversationId(conversation.id)) {
      if (run.status !== 'completed' || run.output === null || existingRunIds.has(run.id)) {
        skipped += 1;
        continue;
      }
      const variant = variants.get(run.output.variantId);
      const messageIndex = messages.findIndex((message) => message.id === run.output?.messageId);
      if (variant === undefined || messageIndex < 0) {
        skipped += 1;
        continue;
      }
      const player = [...messages.slice(0, messageIndex)].reverse().find((message) => message.role === 'user');
      const provider = repositories.providerProfiles.get(run.revisions.provider.id);
      const transition = run.output.transitionId === null
        ? undefined
        : repositories.sceneStateTransitions.get(run.output.transitionId);
      if (provider === undefined || provider.revision !== run.revisions.provider.revision) {
        skipped += 1;
        continue;
      }
      repositories.memoryJobs.create({
        id: randomUUID(), conversationId: conversation.id, kind: 'extract-turn', status: 'pending',
        attempts: 0, nextAttemptAt: null, lastError: null,
        payload: {
          generationId: run.generationId,
          sourceMessageId: run.output.messageId,
          sourceVariantId: run.output.variantId,
          sourceTransitionId: run.output.transitionId,
          sourceAgentRunId: run.id,
          playerInput: player?.content ?? 'Regenerate the latest reply.',
          narrative: variant.content,
          stateOperations: transition?.operations ?? [],
          provider: structuredClone(provider),
          saveAgentConfiguration: run.revisions.saveAgentConfiguration,
        },
      });
      created += 1;
    }
    return reply.status(202).send({ created, skipped });
  });

  app.post<{ Params: { id: string } }>('/api/memory-jobs/:id/retry', async (request, reply) => {
    const job = repositories.memoryJobs.get(request.params.id);
    if (job === undefined) return reply.status(404).send({ error: 'not_found' });
    if (job.status !== 'failed') return reply.status(409).send({ error: 'job_not_failed' });
    const result = repositories.memoryJobs.update(job.id, job.revision, {
      status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null,
    });
    if (!result.ok) return reply.status(409).send({ error: result.reason });
    return reply.status(202).send(result.value);
  });

  app.get('/api/global-embedding-config', async () => publicEmbedding(repositories.globalEmbeddingConfiguration.get()));
  app.put<{ Body: Record<string, unknown> }>('/api/global-embedding-config', async (request, reply) => {
    const expectedRevision = revision(request.body?.revision);
    if (expectedRevision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const patch = Object.fromEntries(
      ['enabled', 'baseUrl', 'model', 'secretRef', 'dimensions']
        .flatMap((key) => Object.hasOwn(request.body ?? {}, key) ? [[key, request.body[key]]] : []),
    );
    try {
      const result = repositories.globalEmbeddingConfiguration.update(expectedRevision, patch);
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return publicEmbedding(result.value);
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
}
