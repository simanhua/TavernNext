import type { ProviderProfile } from '@tavernnext/domain';
import { ProviderError, type ModelInfo, type OpenAICompatibleProfile } from '@tavernnext/provider-openai-compatible';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';

interface ProviderCredentials {
  has(profile: ProviderProfile): boolean;
  read(profile: ProviderProfile): string | undefined;
  put(profileId: string, baseUrl: string, apiKey: string): { secretRef: string; rollback(): void };
  remove(secretRef: string): { rollback(): void };
}

export type ProviderProbeFactory = (profile: OpenAICompatibleProfile) => {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
};

interface Body {
  revision?: unknown;
  expectedRevision?: unknown;
  patch?: unknown;
  apiKey?: unknown;
  [key: string]: unknown;
}

interface ProbeBody {
  id?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}

const revisionFrom = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
  ? value
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;

function safeView(profile: ProviderProfile, credentials: ProviderCredentials) {
  const { secretRef: ignoredSecretRef, headerSecretRefs: ignoredHeaderSecretRefs, ...view } = profile;
  void ignoredSecretRef;
  void ignoredHeaderSecretRefs;
  return { ...view, hasApiKey: credentials.has(profile) };
}

function apiKeyFrom(body: Record<string, unknown>): string | undefined | null {
  if (!Object.hasOwn(body, 'apiKey')) return undefined;
  return typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey : null;
}

function rollbackCredential(change: { rollback(): void } | undefined): void {
  try {
    change?.rollback();
  } catch {
    // The response stays generic and never includes filesystem or credential
    // detail. A future attempt will still fail closed on an untrusted store.
  }
}

function validBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value.trim().replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

function probeError(error: unknown): { status: number; code: string } {
  if (!(error instanceof ProviderError)) return { status: 502, code: 'provider_connection_failed' };
  switch (error.code) {
    case 'auth': return { status: 401, code: 'provider_auth_failed' };
    case 'rate_limit': return { status: 429, code: 'provider_rate_limited' };
    case 'protocol': return { status: 502, code: 'provider_protocol_error' };
    case 'aborted': return { status: 504, code: 'provider_timeout' };
    default: return { status: 502, code: 'provider_connection_failed' };
  }
}

export function registerProviderRoutes(
  app: FastifyInstance,
  database: TavernDatabase,
  repositories: Repositories,
  credentials: ProviderCredentials,
  probeFactory: ProviderProbeFactory,
): void {
  const repository = repositories.providerProfiles;
  const runProbe = async (body: ProbeBody): Promise<ModelInfo[]> => {
    const baseUrl = validBaseUrl(body.baseUrl);
    if (baseUrl === undefined) throw new TypeError('invalid_request');
    const current = typeof body.id === 'string' ? repository.get(body.id) : undefined;
    const suppliedApiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey : undefined;
    const apiKey = suppliedApiKey ?? (current === undefined || current.baseUrl.replace(/\/+$/, '') !== baseUrl
      ? undefined
      : credentials.read(current));
    return probeFactory({ baseUrl, ...(apiKey === undefined ? {} : { apiKey }) })
      .listModels(AbortSignal.timeout(10_000));
  };

  app.get('/api/providers', async () => repository.list().map((profile) => safeView(profile, credentials)));
  app.get<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => {
    const profile = repository.get(request.params.id);
    return profile === undefined ? reply.status(404).send({ error: 'not_found' }) : safeView(profile, credentials);
  });
  app.post<{ Body: ProbeBody }>('/api/providers/probe', async (request, reply) => {
    try {
      const models = await runProbe(request.body ?? {});
      return reply.send({ ok: true, modelCount: models.length });
    } catch (error) {
      if (error instanceof TypeError) return reply.status(400).send({ error: 'invalid_request' });
      const failure = probeError(error);
      return reply.status(failure.status).send({ error: failure.code });
    }
  });
  app.post<{ Body: ProbeBody }>('/api/providers/models', async (request, reply) => {
    try {
      return reply.send({ models: await runProbe(request.body ?? {}) });
    } catch (error) {
      if (error instanceof TypeError) return reply.status(400).send({ error: 'invalid_request' });
      const failure = probeError(error);
      return reply.status(failure.status).send({ error: failure.code });
    }
  });
  app.post<{ Body: Body }>('/api/providers', async (request, reply) => {
    const body = request.body ?? {};
    const apiKey = apiKeyFrom(body);
    if (apiKey === null) return reply.status(400).send({ error: 'invalid_request' });
    const { apiKey: ignoredApiKey, secretRef: ignoredSecretRef, headerSecretRefs: ignoredHeaders, ...fields } = body;
    void ignoredApiKey;
    void ignoredSecretRef;
    void ignoredHeaders;
    const secretRef = apiKey === undefined || typeof fields.id !== 'string'
      ? undefined
      : `browser:${fields.id}`;
    let credentialChange: { rollback(): void } | undefined;
    try {
      if (apiKey !== undefined && (typeof fields.id !== 'string' || typeof fields.baseUrl !== 'string')) throw new Error('invalid input');
      const profile = database.transaction(() => {
        const created = repository.create({ ...fields, ...(secretRef === undefined ? {} : { secretRef }) } as never);
        if (apiKey !== undefined) credentialChange = credentials.put(created.id, created.baseUrl, apiKey);
        return created;
      });
      return reply.status(201).send(safeView(profile, credentials));
    } catch {
      rollbackCredential(credentialChange);
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
  const update = async (request: FastifyRequest<{ Params: { id: string }; Body: Body }>, reply: FastifyReply) => {
    const current = repository.get(request.params.id);
    if (current === undefined) return reply.status(404).send({ error: 'not_found' });
    const revision = revisionFrom(request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    const rawPatch = request.body.patch ?? Object.fromEntries(
      Object.entries(request.body).filter(([key]) => key !== 'revision' && key !== 'expectedRevision'),
    );
    if (typeof rawPatch !== 'object' || rawPatch === null || Array.isArray(rawPatch)) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const patchBody = rawPatch as Record<string, unknown>;
    const apiKey = apiKeyFrom(patchBody);
    if (apiKey === null) return reply.status(400).send({ error: 'invalid_request' });
    const { apiKey: ignoredApiKey, secretRef: ignoredSecretRef, headerSecretRefs: ignoredHeaders, ...fields } = patchBody;
    void ignoredApiKey;
    void ignoredSecretRef;
    void ignoredHeaders;
    let nextSecretRef = current.secretRef;
    if (apiKey !== undefined) nextSecretRef = `browser:${current.id}`;
    else if (typeof fields.baseUrl === 'string' && fields.baseUrl !== current.baseUrl) nextSecretRef = undefined;
    let credentialChange: { rollback(): void } | undefined;
    try {
      const result = database.transaction(() => {
        const updated = repository.update(current.id, revision, {
          ...fields,
          secretRef: nextSecretRef,
        } as never);
        if (!updated.ok) return updated;
        if (apiKey !== undefined) credentialChange = credentials.put(updated.value.id, updated.value.baseUrl, apiKey);
        else if (nextSecretRef === undefined && current.secretRef?.startsWith('browser:')) {
          credentialChange = credentials.remove(current.secretRef);
        }
        return updated;
      });
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.send(safeView(result.value, credentials));
    } catch {
      rollbackCredential(credentialChange);
      return reply.status(400).send({ error: 'invalid_request' });
    }
  };
  app.patch<{ Params: { id: string }; Body: Body }>('/api/providers/:id', update);
  app.put<{ Params: { id: string }; Body: Body }>('/api/providers/:id', update);
  app.delete<{ Params: { id: string }; Querystring: { revision?: string }; Body: Body }>('/api/providers/:id', async (request, reply) => {
    const current = repository.get(request.params.id);
    if (current === undefined) return reply.status(404).send({ error: 'not_found' });
    const revision = revisionFrom(request.query.revision ?? request.body?.revision ?? request.body?.expectedRevision);
    if (revision === undefined) return reply.status(400).send({ error: 'invalid_revision' });
    let credentialChange: { rollback(): void } | undefined;
    try {
      const result = database.transaction(() => {
        const deleted = repository.delete(current.id, revision);
        if (deleted.ok && current.secretRef?.startsWith('browser:')) {
          credentialChange = credentials.remove(current.secretRef);
        }
        return deleted;
      });
      if (!result.ok) return reply.status(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return reply.status(204).send();
    } catch {
      rollbackCredential(credentialChange);
      return reply.status(400).send({ error: 'invalid_request' });
    }
  });
}
