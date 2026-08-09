import { GenerationRequestSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import type { PromptPreviewService } from '../services/prompt-preview-service.js';
import { PromptSnapshotError, promptSnapshotErrorStatus } from '../services/prompt-snapshot-service.js';

export function registerPromptPreviewRoutes(app: FastifyInstance, service: PromptPreviewService): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/conversations/:id/prompt-preview',
    async (request, reply) => {
      const parsed = GenerationRequestSchema.safeParse({
        ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
        conversationId: request.params.id,
      });
      if (!parsed.success || parsed.data.snapshotId !== undefined) {
        return reply.status(400).send({ error: 'invalid_request' });
      }
      try {
        const { snapshotId: ignoredSnapshotId, ...input } = parsed.data;
        void ignoredSnapshotId;
        return reply.status(201).send(await service.preview(input));
      } catch (error) {
        if (error instanceof PromptSnapshotError) {
          return reply.status(promptSnapshotErrorStatus(error.code)).send({ error: error.code });
        }
        throw error;
      }
    },
  );
}
