import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import type { GenerationService } from '../services/generation-service.js';

const InputSchema = z.object({
  sourceVariantId: z.string().uuid(),
  method: z.enum(['createChatMessages', 'triggerSlash']),
  args: z.array(z.unknown()).max(64).default([]),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

class InteractiveActionError extends Error {
  constructor(readonly code: 'invalid_request' | 'conflict', readonly status: 400 | 409) {
    super(code);
  }
}

export function registerInteractiveActionRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  generations: GenerationService,
): void {
  app.post<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/interactive-actions', async (request, reply) => {
    const input = InputSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'invalid_request' });
    const source = repositories.messageVariants.get(input.data.sourceVariantId);
    const sourceMessage = source === undefined ? undefined : repositories.messages.get(source.messageId);
    if (source === undefined || source.status !== 'completed'
      || sourceMessage?.conversationId !== request.params.id
      || sourceMessage.activeVariantId !== source.id) {
      return reply.status(403).send({ error: 'runtime_not_authorized' });
    }
    if (generations.isConversationActive(request.params.id)) {
      return reply.status(409).send({ error: 'generation_active' });
    }
    if (input.data.method === 'createChatMessages') {
      const items = Array.isArray(input.data.args[0]) ? input.data.args[0] : undefined;
      if (items === undefined || items.length > 128) return reply.status(400).send({ error: 'invalid_request' });
      try {
        database.transaction(() => {
          for (const candidate of items) {
            const item = record(candidate);
            const role = item?.role;
            const content = item?.message;
            if (!['system', 'user', 'assistant'].includes(String(role)) || typeof content !== 'string' || content === '') {
              throw new InteractiveActionError('invalid_request', 400);
            }
            const message = repositories.messages.create({
              id: randomUUID(), conversationId: request.params.id,
              role: role as 'system' | 'user' | 'assistant', content, activeVariantId: null,
            });
            if (role === 'assistant') {
              const variant = repositories.messageVariants.create({
                id: randomUUID(), messageId: message.id, content, status: 'completed', finishReason: 'frontend',
              });
              const linked = repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id });
              if (!linked.ok) throw new InteractiveActionError('conflict', 409);
            }
          }
        });
      } catch (error) {
        if (error instanceof InteractiveActionError) return reply.status(error.status).send({ error: error.code });
        throw error;
      }
      return reply.send({ value: true });
    }
    if (input.data.args[0] !== '/trigger') return reply.status(400).send({ error: 'invalid_request' });
    const started = await generations.triggerLastUser(request.params.id);
    if (!started.ok) return reply.status(started.reason === 'generation_active' ? 409 : 422).send({ error: started.reason });
    let output = '';
    for await (const event of started.events) {
      if (event.type === 'delta') output += event.text;
      if (event.type === 'failed') return reply.status(422).send({ error: event.code });
      if (event.type === 'aborted') return reply.status(409).send({ error: 'aborted' });
    }
    return reply.send({ value: output });
  });
}
