import { ExtensionOwnerKindSchema } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import type { createExtensionTrustService } from '../services/extension-trust-service.js';

type TrustService = ReturnType<typeof createExtensionTrustService>;

export function registerExtensionTrustRoutes(app: FastifyInstance, repositories: Repositories, trust: TrustService): void {
  const findOwner = (kind: 'character' | 'preset', id: string) => kind === 'character'
    ? repositories.characters.get(id)
    : repositories.presets.get(id);
  const resolveExistingOwnerKind = (kind: string, id: string) => {
    const result = ExtensionOwnerKindSchema.safeParse(kind);
    return result.success && findOwner(result.data, id) !== undefined ? result.data : undefined;
  };
  app.get<{ Params: { kind: string; id: string } }>('/api/extension-trust/:kind/:id', async (request, reply) => {
    const kind = resolveExistingOwnerKind(request.params.kind, request.params.id);
    return kind === undefined ? reply.status(404).send({ error: 'owner_not_found' }) : trust.review(kind, request.params.id);
  });
  app.post<{ Params: { kind: string; id: string } }>('/api/extension-trust/:kind/:id/refresh', async (request, reply) => {
    const kind = resolveExistingOwnerKind(request.params.kind, request.params.id);
    if (kind === undefined) return reply.status(404).send({ error: 'owner_not_found' });
    const result = await trust.refresh(kind, request.params.id);
    return result.ok ? result.review : reply.status(502).send({ error: result.error, review: result.review });
  });
  app.post<{ Params: { kind: string; id: string } }>('/api/extension-trust/:kind/:id/grant', async (request, reply) => {
    const kind = resolveExistingOwnerKind(request.params.kind, request.params.id);
    if (kind === undefined) return reply.status(404).send({ error: 'owner_not_found' });
    const result = trust.grant(kind, request.params.id);
    return result.ok ? result.review : reply.status(409).send({ error: result.error });
  });
  app.delete<{ Params: { kind: string; id: string } }>('/api/extension-trust/:kind/:id', async (request, reply) => {
    const kind = resolveExistingOwnerKind(request.params.kind, request.params.id);
    return kind === undefined ? reply.status(404).send({ error: 'owner_not_found' }) : trust.revoke(kind, request.params.id);
  });
  app.get<{ Params: { kind: string; id: string } }>('/api/extension-trust/:kind/:id/manifest', async (request, reply) => {
    const kind = resolveExistingOwnerKind(request.params.kind, request.params.id);
    return kind === undefined ? reply.status(404).send({ error: 'owner_not_found' }) : trust.manifest(kind, request.params.id);
  });
  app.get<{ Params: { kind: string; id: string; sha256: string } }>('/api/extension-trust/:kind/:id/cache/:sha256', async (request, reply) => {
    const kind = resolveExistingOwnerKind(request.params.kind, request.params.id);
    if (kind === undefined) return reply.status(404).send({ error: 'owner_not_found' });
    const cached = trust.cached(kind, request.params.id, request.params.sha256);
    if (cached === undefined) return reply.status(404).send({ error: 'cache_not_found' });
    reply.header('content-type', cached.mediaType);
    reply.header('x-content-sha256', cached.sha256);
    return reply.send(Buffer.from(cached.contentBase64, 'base64'));
  });
}
