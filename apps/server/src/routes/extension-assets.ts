import { randomUUID } from 'node:crypto';
import { ExtensionAssetKindSchema, ExtensionOwnerKindSchema } from '@tavernnext/domain';
import { overlayAttachedExtensionAssets } from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { MAX_EXTENSION_ASSETS_PER_OWNER } from '../extension-assets.js';
import { attachedScriptKeys, scriptStateScopeId } from '../runtime-state-validation.js';

const QuerySchema = z.object({
  ownerKind: ExtensionOwnerKindSchema,
  ownerId: z.string().uuid(),
}).strict();
const DraftSchema = z.object({
  kind: ExtensionAssetKindSchema,
  sourceKey: z.string().min(1).max(512),
  ordinal: z.number().int().nonnegative(),
  enabled: z.boolean(),
  payload: z.unknown(),
  diagnostics: z.array(z.string().max(512)).max(128).default([]),
}).strict();
const SaveSchema = z.object({
  ownerRevision: z.number().int().nonnegative(),
  assets: z.array(DraftSchema).max(MAX_EXTENSION_ASSETS_PER_OWNER),
}).strict().superRefine((value, context) => {
  for (const kind of ExtensionAssetKindSchema.options) {
    const assets = value.assets.filter((asset) => asset.kind === kind);
    if (new Set(assets.map((asset) => asset.sourceKey)).size !== assets.length) {
      context.addIssue({ code: 'custom', message: 'duplicate_source_key', path: ['assets'] });
    }
    const ordinals = assets.map((asset) => asset.ordinal).sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      context.addIssue({ code: 'custom', message: 'invalid_resource_order', path: ['assets'] });
    }
  }
});

function sorted<T extends { kind: 'regex' | 'tavern_helper'; ordinal: number; sourceKey: string }>(assets: readonly T[]): T[] {
  return [...assets].sort((left, right) => (
    (left.kind === right.kind ? 0 : left.kind === 'regex' ? -1 : 1)
    || left.ordinal - right.ordinal
    || (left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0)
  ));
}

function canonicalEnabled(asset: z.infer<typeof DraftSchema>): z.infer<typeof DraftSchema> {
  if (typeof asset.payload !== 'object' || asset.payload === null || Array.isArray(asset.payload)) return asset;
  const payload = asset.payload as Record<string, unknown>;
  return {
    ...asset,
    payload: asset.kind === 'regex'
      ? { ...payload, disabled: !asset.enabled }
      : { ...payload, enabled: asset.enabled },
  };
}

export function registerExtensionAssetRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
): void {
  const owner = (kind: 'character' | 'preset', id: string) => kind === 'character'
    ? repositories.characters.get(id)
    : repositories.presets.get(id);
  const response = (kind: 'character' | 'preset', id: string) => {
    const value = owner(kind, id);
    if (value === undefined) return undefined;
    return {
      owner: { kind, id: value.id, revision: value.revision, name: value.name },
      assets: sorted(repositories.extensionAssets.listByOwner(kind, id)).map((asset) => ({
        kind: asset.kind,
        sourceKey: asset.sourceKey,
        ordinal: asset.ordinal,
        enabled: asset.enabled,
        payload: structuredClone(asset.payload),
        diagnostics: [...asset.diagnostics],
      })),
    };
  };

  app.get<{ Querystring: unknown }>('/api/extension-assets', async (request, reply) => {
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_request' });
    const value = response(query.data.ownerKind, query.data.ownerId);
    return value === undefined ? reply.status(404).send({ error: 'not_found' }) : value;
  });

  app.put<{ Querystring: unknown; Body: unknown }>('/api/extension-assets', async (request, reply) => {
    const query = QuerySchema.safeParse(request.query);
    const body = SaveSchema.safeParse(request.body);
    if (!query.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    const current = owner(query.data.ownerKind, query.data.ownerId);
    if (current === undefined) return reply.status(404).send({ error: 'not_found' });
    if (current.revision !== body.data.ownerRevision) {
      return reply.status(409).send({ error: 'conflict', ownerRevision: current.revision });
    }
    const assets = sorted(body.data.assets.map(canonicalEnabled));
    const currentScriptKeys = repositories.extensionAssets.listByOwner(query.data.ownerKind, current.id)
      .filter((asset) => asset.kind === 'tavern_helper')
      .flatMap((asset) => [asset.sourceKey, ...attachedScriptKeys(asset.payload)]);
    const nextScriptKeys = new Set(assets.filter((asset) => asset.kind === 'tavern_helper')
      .flatMap((asset) => [asset.sourceKey, ...attachedScriptKeys(asset.payload)]));
    const extensions = overlayAttachedExtensionAssets(current.extensions, assets, { replaceKinds: true });
    const result = database.transaction(() => {
      const updated = query.data.ownerKind === 'character'
        ? repositories.characters.update(current.id, current.revision, { extensions })
        : repositories.presets.update(current.id, current.revision, { extensions });
      if (!updated.ok) return updated;
      repositories.extensionAssets.deleteByOwner(query.data.ownerKind, current.id);
      for (const scriptKey of currentScriptKeys) {
        if (!nextScriptKeys.has(scriptKey)) {
          repositories.extensionStates.deleteByScope(
            'script', scriptStateScopeId(query.data.ownerKind, current.id, scriptKey),
          );
        }
      }
      for (const asset of assets) {
        repositories.extensionAssets.create({
          id: randomUUID(), ownerKind: query.data.ownerKind, ownerId: current.id,
          kind: asset.kind, sourceKey: asset.sourceKey, ordinal: asset.ordinal,
          enabled: asset.enabled, payload: asset.payload, diagnostics: asset.diagnostics,
        });
      }
      return updated;
    });
    if (!result.ok) {
      const latest = owner(query.data.ownerKind, query.data.ownerId);
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({
        error: result.reason,
        ...(latest === undefined ? {} : { ownerRevision: latest.revision }),
      });
    }
    return response(query.data.ownerKind, query.data.ownerId)!;
  });
}
