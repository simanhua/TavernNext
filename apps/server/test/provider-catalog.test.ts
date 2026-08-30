import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((value) => value())));

describe('Pi Provider catalog', () => {
  it('exposes API-key providers, disables OAuth-only providers, and includes custom endpoints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-provider-catalog-'));
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/providers/catalog' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openai', name: 'OpenAI', authentication: 'api_key', available: true }),
      expect.objectContaining({
        id: 'openai-codex', authentication: 'subscription', available: false,
        unavailableReason: 'Subscription login is not supported yet.',
      }),
      expect.objectContaining({
        id: 'amazon-bedrock', authentication: 'composite', available: false,
      }),
      expect.objectContaining({ id: 'custom-openai-compatible', authentication: 'api_key', available: true, customBaseUrl: true }),
    ]));
    const openai = response.json().find((provider: { id: string }) => provider.id === 'openai');
    expect(openai.models.length).toBeGreaterThan(0);
    expect(openai.models.every((model: { id?: unknown; name?: unknown }) => (
      typeof model.id === 'string' && typeof model.name === 'string'
    ))).toBe(true);
    expect(JSON.stringify(response.json())).not.toMatch(/apiKey|secret/i);
  });

  it('stores a catalog Provider/model identity and rejects unavailable or unknown Agent selections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-provider-selection-'));
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    await app.ready();

    const catalog = await app.inject({ method: 'GET', url: '/api/providers/catalog' });
    const openai = catalog.json().find((provider: { id: string }) => provider.id === 'openai');
    const model = openai.models[0];
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: '018f0000-0000-7000-8000-000000000101',
        name: 'OpenAI Agent',
        providerId: 'openai',
        modelId: model.id,
        apiKey: 'never-return-this',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      providerId: 'openai', modelId: model.id, baseUrl: model.baseUrl, hasApiKey: true,
    });
    expect(created.body).not.toContain('never-return-this');
    expect(created.json()).not.toHaveProperty('apiMode');
    expect(created.json()).not.toHaveProperty('model');

    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: '018f0000-0000-7000-8000-000000000102', name: 'Codex subscription',
        providerId: 'openai-codex', modelId: 'gpt-5.4', apiKey: 'ignored',
      },
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json()).toEqual({ error: 'provider_unavailable' });

    const unknownModel = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: '018f0000-0000-7000-8000-000000000103', name: 'Unknown model',
        providerId: 'openai', modelId: 'not-a-tool-model', apiKey: 'ignored',
      },
    });
    expect(unknownModel.statusCode).toBe(400);
    expect(unknownModel.json()).toEqual({ error: 'model_not_agent_capable' });
  });

  it('keeps custom OpenAI-compatible endpoints as explicit custom Provider profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-provider-custom-'));
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: '018f0000-0000-7000-8000-000000000104', name: 'Local model',
        providerId: 'custom-openai-compatible', modelId: 'local-agent-model',
        customBaseUrl: 'http://127.0.0.1:8080/v1/',
        apiKey: 'custom-secret',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      providerId: 'custom-openai-compatible', modelId: 'local-agent-model',
      baseUrl: 'http://127.0.0.1:8080/v1', customBaseUrl: 'http://127.0.0.1:8080/v1',
      toolCalls: false, hasApiKey: true,
    });

    const refusedActivation = await app.inject({
      method: 'PATCH',
      url: '/api/settings/generation',
      payload: { revision: 0, patch: { providerId: '018f0000-0000-7000-8000-000000000104' } },
    });
    expect(refusedActivation.statusCode).toBe(400);
    expect(refusedActivation.json()).toEqual({ error: 'model_not_agent_capable' });

    const changedEndpoint = await app.inject({
      method: 'PATCH',
      url: '/api/providers/018f0000-0000-7000-8000-000000000104',
      payload: { revision: 0, patch: { customBaseUrl: 'http://127.0.0.1:9090/v1' } },
    });
    expect(changedEndpoint.json()).toMatchObject({ revision: 1, hasApiKey: false });
    const restoredEndpoint = await app.inject({
      method: 'PATCH',
      url: '/api/providers/018f0000-0000-7000-8000-000000000104',
      payload: {
        revision: 1,
        patch: { customBaseUrl: 'http://127.0.0.1:8080/v1', toolCalls: true },
      },
    });
    expect(restoredEndpoint.json()).toMatchObject({ revision: 2, hasApiKey: false, toolCalls: true });
    const activated = await app.inject({
      method: 'PATCH',
      url: '/api/settings/generation',
      payload: { revision: 0, patch: { providerId: '018f0000-0000-7000-8000-000000000104' } },
    });
    expect(activated.statusCode).toBe(200);
  });
});
