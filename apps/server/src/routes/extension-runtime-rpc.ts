import { ExtensionRuntimeRpcEnvelopeSchema } from '@tavernnext/extension-runtime';
import type { FastifyInstance } from 'fastify';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import type { GenerationService } from '../services/generation-service.js';
import type { createExtensionTrustService } from '../services/extension-trust-service.js';
import { createExtensionRuntimeRpcService, RpcError } from '../services/extension-runtime-rpc-service.js';

type TrustService = ReturnType<typeof createExtensionTrustService>;

export function registerExtensionRuntimeRpcRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  generations: GenerationService,
  trust: TrustService,
): void {
  const service = createExtensionRuntimeRpcService(database, repositories, generations, trust);
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/extension-runtime/rpc',
    async (request, reply) => {
      const parsed = ExtensionRuntimeRpcEnvelopeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
      try {
        return reply.send({ value: await service.execute(request.params.id, parsed.data) });
      } catch (error) {
        if (error instanceof RpcError) return reply.status(error.status).send({ error: error.code });
        return reply.status(400).send({ error: 'invalid_request' });
      }
    },
  );
}
