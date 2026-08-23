import {
  GenerationCandidateTransportSchema,
  GenerationRequestSchema,
  SealGenerationCandidateSchema,
} from '@tavernnext/domain';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PromptSnapshotError, promptSnapshotErrorStatus } from '../services/prompt-snapshot-service.js';
import type { createGenerationCandidateService } from '../services/generation-candidate-service.js';

type CandidateService = ReturnType<typeof createGenerationCandidateService>;
function sendCandidateError(error: unknown, reply: FastifyReply) {
  if (error instanceof PromptSnapshotError) return reply.status(promptSnapshotErrorStatus(error.code)).send({ error: error.code });
  throw error;
}
const CreateSchema = GenerationRequestSchema.omit({ conversationId: true, snapshotId: true }).strict();

export function registerGenerationCandidateRoutes(app: FastifyInstance, service: CandidateService): void {
  app.post<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/generation-candidates', async (request, reply) => {
    const input = CreateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const candidate = await service.create({ conversationId: request.params.id, ...input.data });
      return reply.status(201).send(GenerationCandidateTransportSchema.parse(candidate));
    }
    catch (error) { return sendCandidateError(error, reply); }
  });
  app.post<{ Params: { candidateId: string }; Body: unknown }>('/api/generation-candidates/:candidateId/seal', async (request, reply) => {
    const input = SealGenerationCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'invalid_request' });
    try { return reply.status(201).send(await service.seal(request.params.candidateId, input.data.patch)); }
    catch (error) { return sendCandidateError(error, reply); }
  });
  app.delete<{ Params: { candidateId: string } }>('/api/generation-candidates/:candidateId', async (request, reply) => (
    service.discard(request.params.candidateId)
      ? reply.status(204).send()
      : reply.status(404).send({ error: 'not_found' })
  ));
}
