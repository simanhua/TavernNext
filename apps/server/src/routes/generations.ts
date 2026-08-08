import { Readable } from 'node:stream';
import { GenerationRequestSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import type { GenerationEvent, GenerationService } from '../services/generation-service.js';

function encode(event: GenerationEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* encodeEvents(events: AsyncIterable<GenerationEvent>): AsyncIterable<string> {
  for await (const event of events) yield encode(event);
}

export function registerGenerationRoutes(app: FastifyInstance, service: GenerationService): void {
  app.post<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/generations', async (request, reply) => {
    const parsed = GenerationRequestSchema.safeParse({
      ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      conversationId: request.params.id,
    });
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const result = service.start(parsed.data);
    if (!result.ok) {
      const status = result.reason === 'unsupported_mode' || result.reason === 'invalid_user_text' ? 400
        : result.reason === 'not_found' ? 404
        : result.reason === 'provider_not_configured' ? 422
          : 409;
      return reply.status(status).send({ error: result.reason });
    }
    reply.headers({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const detachLifecycleListeners = () => {
      request.raw.off('aborted', cancelGeneration);
      reply.raw.off('close', handleClose);
      reply.raw.off('finish', detachLifecycleListeners);
    };
    const cancelGeneration = () => {
      service.cancel(result.generationId);
      detachLifecycleListeners();
    };
    const handleClose = () => {
      if (!reply.raw.writableEnded) cancelGeneration();
      else detachLifecycleListeners();
    };
    request.raw.once('aborted', cancelGeneration);
    reply.raw.once('close', handleClose);
    reply.raw.once('finish', detachLifecycleListeners);
    return reply.send(Readable.from(encodeEvents(result.events)));
  });

  app.delete<{ Params: { id: string } }>('/api/generations/:id', async (request, reply) => {
    if (!service.cancel(request.params.id)) return reply.status(404).send({ error: 'not_found' });
    return reply.status(202).send({ status: 'cancelling' });
  });
}
