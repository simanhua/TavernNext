import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { resolveActiveResourceContext } from '../services/active-extension-resources.js';
import type { createExtensionTrustService } from '../services/extension-trust-service.js';
import type { SaveAgentRuntime } from '../services/save-agent-runtime.js';

type TrustService = ReturnType<typeof createExtensionTrustService>;

const InputSchema = z.object({
  sourceVariantId: z.string().uuid(),
  method: z.enum(['createChatMessages', 'triggerSlash']),
  args: z.array(z.unknown()).max(64).default([]),
}).strict();
const InteractiveResourceQuerySchema = z.object({
  sourceVariantId: z.string().uuid(),
  url: z.string().url(),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function approvedHtmlMediaType(url: string, mediaType: string, contentBase64: string): string | undefined {
  if (/^text\/html(?:$|;)/i.test(mediaType)) return mediaType;
  if (!/^text\/plain(?:$|;)/i.test(mediaType)) return undefined;
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return undefined; }
  if (!pathname.toLowerCase().endsWith('.html')) return undefined;
  const prefix = Buffer.from(contentBase64, 'base64').subarray(0, 1_024).toString('utf8').trimStart();
  return /^(?:<!doctype\s+html\b|<html\b)/i.test(prefix) ? 'text/html; charset=utf-8' : undefined;
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
  generations: SaveAgentRuntime,
  trust: TrustService,
): void {
  const authorizedSource = (conversationId: string, sourceVariantId: string) => {
    const source = repositories.messageVariants.get(sourceVariantId);
    const sourceMessage = source === undefined ? undefined : repositories.messages.get(source.messageId);
    return source !== undefined && source.status === 'completed'
      && sourceMessage?.conversationId === conversationId
      && sourceMessage.activeVariantId === source.id;
  };
  app.get<{ Params: { id: string }; Querystring: unknown }>(
    '/api/conversations/:id/interactive-resource',
    async (request, reply) => {
      const input = InteractiveResourceQuerySchema.safeParse(request.query);
      if (!input.success) return reply.status(400).send({ error: 'invalid_request' });
      if (!authorizedSource(request.params.id, input.data.sourceVariantId)) {
        return reply.status(403).send({ error: 'runtime_not_authorized' });
      }
      const context = resolveActiveResourceContext(repositories, request.params.id);
      for (const owner of context.owners) {
        const review = trust.review(owner.kind, owner.id);
        if (!review.trusted) continue;
        const remote = review.remotes.find((candidate) => (
          candidate.url === input.data.url && candidate.fetched && candidate.sha256 !== null
        ));
        if (remote?.sha256 === null || remote?.sha256 === undefined) continue;
        const cached = trust.cached(owner.kind, owner.id, remote.sha256);
        if (cached === undefined) continue;
        const mediaType = approvedHtmlMediaType(remote.url, cached.mediaType, cached.contentBase64);
        if (mediaType === undefined) continue;
        reply.header('content-type', mediaType);
        reply.header('cache-control', 'private, no-store');
        reply.header('x-content-sha256', cached.sha256);
        return reply.send(Buffer.from(cached.contentBase64, 'base64'));
      }
      return reply.status(403).send({ error: 'runtime_not_authorized' });
    },
  );
  app.post<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/interactive-actions', async (request, reply) => {
    const input = InputSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'invalid_request' });
    if (!authorizedSource(request.params.id, input.data.sourceVariantId)) {
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
