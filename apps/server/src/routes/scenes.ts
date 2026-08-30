import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { PlayerOperationSchema, SCENE_ACTION_ENVELOPE_PROTOCOL } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import { SceneServiceError, type SceneService } from '../scenes/scene-service.js';
import { isBundledOfficialScene } from '../scenes/official-package.js';
import type { SaveAgentRuntime } from '../services/save-agent-runtime.js';

const SceneActionEnvelopeSchema = z.object({
  $tavernnext: z.literal(SCENE_ACTION_ENVELOPE_PROTOCOL),
  action: z.unknown(),
  operation: PlayerOperationSchema.optional(),
}).strict();

const mediaTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function sceneError(error: unknown, reply: { status(code: number): { send(value: unknown): unknown } }) {
  if (error instanceof SceneServiceError) return reply.status(error.statusCode).send({ error: error.code });
  if (error instanceof Error && error.name === 'ZodError') return reply.status(422).send({ error: 'scene_module_output_invalid' });
  return reply.status(500).send({ error: 'scene_operation_failed' });
}

export function registerSceneRoutes(
  app: FastifyInstance,
  scenes: SceneService,
  repositories: Repositories,
  generations: SaveAgentRuntime,
): void {
  const detail = (sceneId: string) => {
    const scene = scenes.get(sceneId);
    if (scene === undefined) return undefined;
    const conversations = scenes.listConversations(sceneId);
    const messageCount = conversations.reduce(
      (count, conversation) => count + repositories.messages.listByConversationId(conversation.id).length,
      0,
    );
    return {
      ...scene,
      coverUrl: scene.manifest.coverPath === undefined
        ? undefined
        : `/api/scenes/${encodeURIComponent(scene.id)}/assets/${scene.manifest.coverPath}`,
      conversationCount: conversations.length,
      messageCount,
      fullyTrusted: isBundledOfficialScene(scene),
      trustNotice: 'This official Scene runs as fully trusted same-origin frontend code with optional server code. It may access TavernNext APIs, browser storage, global objects, and the network.',
    };
  };

  app.get('/api/scenes/catalog', async (_request, reply) => {
    try {
      const catalog = scenes.catalog();
      const installed = new Map(scenes.list().map((scene) => [scene.id, scene]));
      return catalog.scenes.map((entry) => {
        const scene = installed.get(entry.sceneId);
        return {
          ...entry,
          installed: scene !== undefined,
          ...(scene?.manifest.coverPath === undefined ? {} : {
            coverUrl: `/api/scenes/${encodeURIComponent(scene.id)}/assets/${scene.manifest.coverPath}`,
          }),
        };
      });
    } catch (error) {
      return sceneError(error, reply);
    }
  });

  app.get('/api/scenes', async () => scenes.list().map((scene) => detail(scene.id)!));

  app.get<{ Params: { id: string } }>('/api/scenes/:id', async (request, reply) => {
    const value = detail(request.params.id);
    return value === undefined ? reply.status(404).send({ error: 'scene_not_found' }) : value;
  });

  app.post<{ Params: { id: string } }>('/api/scenes/:id/install', async (request, reply) => {
    try {
      const scene = await scenes.install(request.params.id);
      return reply.status(201).send(detail(scene.id));
    } catch (error) {
      return sceneError(error, reply);
    }
  });

  app.delete<{ Params: { id: string }; Body: unknown }>('/api/scenes/:id', async (request, reply) => {
    const parsed = z.object({ revision: z.number().int().nonnegative(), cascade: z.literal(true) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'cascade_confirmation_required' });
    try {
      return await scenes.uninstall(request.params.id, parsed.data.revision);
    } catch (error) {
      return sceneError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/api/scenes/:id/conversations', async (request, reply) => {
    if (scenes.get(request.params.id) === undefined) return reply.status(404).send({ error: 'scene_not_found' });
    return scenes.listConversations(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/scenes/:id/conversations', async (request, reply) => {
    try {
      return reply.status(201).send(await scenes.createConversation(request.params.id, request.body));
    } catch (error) {
      return sceneError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/scene-state', async (request, reply) => {
    const conversation = repositories.conversations.get(request.params.id);
    if (conversation?.sceneId === undefined) return reply.status(404).send({ error: 'scene_state_not_found' });
    return scenes.state(conversation.id) ?? reply.status(404).send({ error: 'scene_state_not_found' });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/scene-state', async (request, reply) => {
    const parsed = z.object({ revision: z.number().int().nonnegative(), patch: z.array(z.unknown()) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const conversation = repositories.conversations.get(request.params.id);
    if (conversation?.sceneId === undefined) return reply.status(404).send({ error: 'scene_state_not_found' });
    try {
      return scenes.patchState(conversation.id, parsed.data.revision, parsed.data.patch);
    } catch (error) {
      return sceneError(error, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/scene-actions', async (request, reply) => {
    if (generations.isConversationActive(request.params.id)) {
      return reply.status(409).send({ error: 'generation_active' });
    }
    const candidate = typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : undefined;
    const usesEnvelope = candidate?.$tavernnext === SCENE_ACTION_ENVELOPE_PROTOCOL;
    const envelope = usesEnvelope ? SceneActionEnvelopeSchema.safeParse(request.body) : undefined;
    if (envelope !== undefined && !envelope.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return await scenes.performAction(
        request.params.id,
        envelope?.success === true ? envelope.data.action : request.body,
        envelope?.success === true ? envelope.data.operation : undefined,
        () => !generations.isConversationActive(request.params.id),
      );
    } catch (error) {
      return sceneError(error, reply);
    }
  });

  app.get<{ Params: { id: string; '*': string } }>('/api/scenes/:id/assets/*', async (request, reply) => {
    try {
      const path = scenes.assetPath(request.params.id, request.params['*']);
      const extension = extname(path).toLowerCase();
      if (extension === '.html') {
        reply.header('content-security-policy', [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self' https: 'unsafe-inline'",
          "img-src 'self' https: http: data: blob:",
          "font-src 'self' https: http: data:",
          "connect-src *",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
        ].join('; '));
      }
      reply.header('access-control-allow-origin', '*');
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      return reply.type(mediaTypes[extension] ?? 'application/octet-stream').send(readFileSync(path));
    } catch (error) {
      return sceneError(error, reply);
    }
  });
}
