import { randomUUID } from 'node:crypto';
import { ExtensionStateScopeSchema, type ExtensionStateScope } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import {
  assertRuntimeStateValue,
  attachedScriptKeys,
  parseScriptStateScopeId,
  RuntimeStateLimitError,
} from '../runtime-state-validation.js';

const ValueSchema = z.record(z.string().max(512), z.unknown()).superRefine((value, context) => {
  try { assertRuntimeStateValue(value); }
  catch { context.addIssue({ code: 'custom', message: 'runtime_state_limit' }); }
});
const OperationSchema = z.discriminatedUnion('operation', [
  z.object({ expectedRevision: z.number().int().nonnegative().nullable(), operation: z.literal('replace'), value: ValueSchema }).strict(),
  z.object({ expectedRevision: z.number().int().nonnegative().nullable(), operation: z.literal('merge'), value: ValueSchema }).strict(),
  z.object({ expectedRevision: z.number().int().nonnegative().nullable(), operation: z.literal('insert'), value: ValueSchema }).strict(),
  z.object({
    expectedRevision: z.number().int().nonnegative().nullable(), operation: z.literal('delete'),
    keys: z.array(z.string().min(1).max(512)).max(50_000),
  }).strict(),
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mergeValue(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    const currentObject = record(result[key]);
    const patchObject = record(value);
    result[key] = currentObject !== undefined && patchObject !== undefined
      ? mergeValue(currentObject, patchObject)
      : structuredClone(value);
  }
  return result;
}

function insertValue(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(result, key)) {
      result[key] = structuredClone(value);
      continue;
    }
    const currentObject = record(result[key]);
    const patchObject = record(value);
    if (currentObject !== undefined && patchObject !== undefined) result[key] = insertValue(currentObject, patchObject);
  }
  return result;
}

function view(scope: ExtensionStateScope, scopeId: string, state: ReturnType<Repositories['extensionStates']['getByScope']>) {
  return state === undefined
    ? { scope, scopeId, revision: null, value: {} }
    : { scope, scopeId, revision: state.revision, value: structuredClone(state.value) };
}

export function registerRuntimeStateRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
): void {
  const validOwner = (scope: ExtensionStateScope, scopeId: string) => {
    switch (scope) {
      case 'global': return scopeId === 'global';
      case 'character': return repositories.characters.get(scopeId) !== undefined;
      case 'preset': return repositories.presets.get(scopeId) !== undefined;
      case 'conversation': return repositories.conversations.get(scopeId) !== undefined;
      case 'message-variant': return repositories.messageVariants.get(scopeId) !== undefined;
      case 'script': {
        const identity = parseScriptStateScopeId(scopeId);
        if (identity === undefined) return false;
        const ownerExists = identity.ownerKind === 'character'
          ? repositories.characters.get(identity.ownerId) !== undefined
          : repositories.presets.get(identity.ownerId) !== undefined;
        if (!ownerExists) return false;
        return repositories.extensionAssets.listByOwner(identity.ownerKind, identity.ownerId)
          .filter((asset) => asset.kind === 'tavern_helper')
          .some((asset) => asset.sourceKey === identity.scriptKey || attachedScriptKeys(asset.payload).includes(identity.scriptKey));
      }
    }
  };
  const parsedScope = (value: string) => ExtensionStateScopeSchema.safeParse(value);
  const apply = (scope: ExtensionStateScope, scopeId: string, input: z.infer<typeof OperationSchema>) => database.transaction(() => {
    const current = repositories.extensionStates.getByScope(scope, scopeId);
    if ((current?.revision ?? null) !== input.expectedRevision) {
      return { ok: false as const, revision: current?.revision ?? null };
    }
    const value = (() => {
      if (input.operation === 'replace') return structuredClone(input.value);
      if (input.operation === 'merge') return mergeValue(current?.value ?? {}, input.value);
      if (input.operation === 'insert') return insertValue(current?.value ?? {}, input.value);
      const next = structuredClone(current?.value ?? {});
      for (const key of input.keys) delete next[key];
      return next;
    })();
    assertRuntimeStateValue(value);
    if (current === undefined) {
      return { ok: true as const, value: repositories.extensionStates.create({
        id: randomUUID(), scope, scopeId, value,
      }) };
    }
    const updated = repositories.extensionStates.update(current.id, current.revision, { value });
    return updated.ok ? { ok: true as const, value: updated.value } : { ok: false as const, revision: current.revision };
  });

  app.get<{ Params: { scope: string; scopeId: string } }>('/api/runtime-states/:scope/:scopeId', async (request, reply) => {
    const scope = parsedScope(request.params.scope);
    if (!scope.success) return reply.status(400).send({ error: 'invalid_scope' });
    if (!validOwner(scope.data, request.params.scopeId)) return reply.status(404).send({ error: 'scope_owner_not_found' });
    return view(scope.data, request.params.scopeId, repositories.extensionStates.getByScope(scope.data, request.params.scopeId));
  });
  app.post<{ Params: { scope: string; scopeId: string }; Body: unknown }>('/api/runtime-states/:scope/:scopeId', async (request, reply) => {
    const scope = parsedScope(request.params.scope);
    if (!scope.success) return reply.status(400).send({ error: 'invalid_scope' });
    if (!validOwner(scope.data, request.params.scopeId)) return reply.status(404).send({ error: 'scope_owner_not_found' });
    const input = OperationSchema.safeParse(request.body);
    if (!input.success) return input.error.issues.some((issue) => issue.message === 'runtime_state_limit')
      ? reply.status(422).send({ error: 'runtime_state_limit' })
      : reply.status(400).send({ error: 'invalid_state_operation' });
    let result: ReturnType<typeof apply>;
    try { result = apply(scope.data, request.params.scopeId, input.data); }
    catch (error) {
      if (error instanceof RuntimeStateLimitError) return reply.status(422).send({ error: error.code });
      throw error;
    }
    if (!result.ok) return reply.status(409).send({ error: 'conflict', revision: result.revision });
    return view(scope.data, request.params.scopeId, result.value);
  });
  app.get<{ Params: { id: string } }>('/api/messages/:id/runtime-state', async (request, reply) => {
    const message = repositories.messages.get(request.params.id);
    if (message === undefined) return reply.status(404).send({ error: 'not_found' });
    if (message.activeVariantId === null) return reply.status(409).send({ error: 'active_variant_required' });
    return view(
      'message-variant', message.activeVariantId,
      repositories.extensionStates.getByScope('message-variant', message.activeVariantId),
    );
  });
}
