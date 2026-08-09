import { PresetKindSchema } from '@tavernnext/domain';
import { executablePresetFields, validatePresetFamily } from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import { presetDetail, presetSummary, safePresetSettings } from './manager-dtos.js';

const MAX_MANAGER_ROWS = 512;
const markerKey = '__tavernnextPresetSource';
const SettingsSchema = z.record(z.string(), z.unknown());
const CreateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  kind: PresetKindSchema,
  settings: SettingsSchema,
}).strict();
const PatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: z.object({ name: z.string().min(1).optional(), settings: SettingsSchema.optional() })
    .strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identity(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') return `${typeof candidate}:${String(candidate)}`;
  }
  return undefined;
}

function preserveMarkers(
  currentValue: unknown,
  nextValue: unknown,
  identityKeys: readonly string[],
  nested?: (current: Record<string, unknown>, next: Record<string, unknown>) => void,
): unknown {
  if (!Array.isArray(nextValue)) return structuredClone(nextValue);
  const current: Record<string, unknown>[] = Array.isArray(currentValue)
    ? currentValue.map(record).filter((value): value is Record<string, unknown> => value !== undefined)
    : [];
  const queues = new Map<string, Record<string, unknown>[]>();
  for (const item of current) {
    const key = identity(item, identityKeys);
    if (key === undefined) continue;
    const queue = queues.get(key) ?? [];
    queue.push(item);
    queues.set(key, queue);
  }
  return nextValue.map((value) => {
    const next = record(value);
    if (next === undefined) return structuredClone(value);
    const copy = structuredClone(next);
    const key = identity(next, identityKeys);
    const prior = key === undefined ? undefined : queues.get(key)?.shift();
    if (prior !== undefined && Object.hasOwn(prior, markerKey) && !Object.hasOwn(copy, markerKey)) {
      copy[markerKey] = structuredClone(prior[markerKey]);
    }
    if (prior !== undefined) nested?.(prior, copy);
    return copy;
  });
}

function mergeSettings(
  current: Record<string, unknown>,
  edited: Record<string, unknown>,
  kind: z.infer<typeof PresetKindSchema>,
): Record<string, unknown> {
  const merged = structuredClone(current);
  for (const [key, value] of Object.entries(edited)) merged[key] = structuredClone(value);
  if (kind === 'chat' && Object.hasOwn(edited, 'prompts')) {
    merged.prompts = preserveMarkers(current.prompts, edited.prompts, ['identifier']);
  }
  if (kind === 'chat' && Object.hasOwn(edited, 'prompt_order')) {
    merged.prompt_order = preserveMarkers(current.prompt_order, edited.prompt_order, ['character_id'], (prior, next) => {
      if (Object.hasOwn(next, 'order')) next.order = preserveMarkers(prior.order, next.order, ['identifier']);
    });
  }
  if (kind === 'text' && Object.hasOwn(edited, 'order')) {
    merged.order = preserveMarkers(current.order, edited.order, ['id']);
  }
  return merged;
}

function validatedSettings(kind: z.infer<typeof PresetKindSchema>, settings: Record<string, unknown>): Record<string, unknown> {
  return executablePresetFields(kind, validatePresetFamily(kind, settings)).settings;
}

function revisionFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function registerPresetRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get('/api/presets', async (_request, reply) => {
    const rows = repositories.presets.list(MAX_MANAGER_ROWS + 1);
    if (rows.length > MAX_MANAGER_ROWS) return reply.status(422).send({ error: 'manager_list_limit' });
    return rows.map(presetSummary);
  });
  app.get<{ Params: { id: string } }>('/api/presets/:id', async (request, reply) => {
    const value = repositories.presets.get(request.params.id);
    if (value === undefined) return reply.status(404).send({ error: 'not_found' });
    try {
      return presetDetail(value);
    } catch {
      return reply.status(422).send({ error: 'invalid_preset' });
    }
  });
  app.post<{ Body: unknown }>('/api/presets', async (request, reply) => {
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const settings = validatedSettings(parsed.data.kind, parsed.data.settings);
      const value = repositories.presets.create({ ...parsed.data, settings });
      return reply.status(201).send(presetDetail(value));
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/presets/:id', async (request, reply) => {
    const parsed = PatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const current = repositories.presets.get(request.params.id);
    if (current === undefined) return reply.status(404).send({ error: 'not_found' });
    if (current.revision !== parsed.data.revision) return reply.status(409).send({ error: 'conflict' });
    try {
      const patch: { name?: string; settings?: Record<string, unknown> } = {};
      if (parsed.data.patch.name !== undefined) patch.name = parsed.data.patch.name;
      if (parsed.data.patch.settings !== undefined) {
        const safeCurrent = safePresetSettings(current);
        const safeEdited = validatedSettings(current.kind, { ...safeCurrent, ...parsed.data.patch.settings });
        patch.settings = mergeSettings(current.settings, safeEdited, current.kind);
      }
      const result = repositories.presets.update(current.id, parsed.data.revision, patch);
      if (result.ok) return reply.send(presetDetail(result.value));
      return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
    } catch {
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: unknown }>(
    '/api/presets/:id',
    async (request, reply) => {
      const bodyRevision = typeof request.body === 'object' && request.body !== null && 'revision' in request.body
        ? (request.body as { revision?: unknown }).revision
        : undefined;
      const revision = revisionFrom(request.query.revision ?? bodyRevision);
      if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
      try {
        const result = repositories.presets.delete(request.params.id, revision);
        if (result.ok) return reply.status(204).send();
        return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      } catch {
        return reply.status(409).send({ error: 'constraint_conflict' });
      }
    },
  );
}
