// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { ConnectionPage } from './ConnectionPage.js';

const providerCatalog = [
  {
    id: 'openai', name: 'OpenAI', authentication: 'api_key', available: true,
    customBaseUrl: false, baseUrl: 'https://api.openai.com/v1', credentialLabel: 'OpenAI API key',
    models: [
      { id: 'gpt-agent', name: 'GPT Agent', baseUrl: 'https://api.openai.com/v1', toolCalls: true },
      { id: 'gpt-agent-mini', name: 'GPT Agent Mini', baseUrl: 'https://api.openai.com/v1', toolCalls: true },
    ],
  },
  {
    id: 'openai-codex', name: 'OpenAI Codex', authentication: 'subscription', available: false,
    customBaseUrl: false, unavailableReason: 'Subscription login is not supported yet.', models: [],
  },
  {
    id: 'amazon-bedrock', name: 'Amazon Bedrock', authentication: 'composite', available: false,
    customBaseUrl: false,
    unavailableReason: 'This Provider needs composite cloud credentials that TavernNext does not support yet.',
    models: [],
  },
  {
    id: 'custom-openai-compatible', name: 'Custom OpenAI-compatible', authentication: 'api_key', available: true,
    customBaseUrl: true, credentialLabel: 'API key', models: [],
  },
];

const server = setupServer(
  http.get('/api/providers', () => HttpResponse.json([])),
  http.get('/api/providers/catalog', () => HttpResponse.json(providerCatalog)),
  http.get('/api/presets', () => HttpResponse.json([])),
  http.get('/api/settings/generation', () => HttpResponse.json({
    id: '018f0000-0000-7000-8000-000000000001', revision: 0,
    createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
    providerId: null, chatPresetId: null, textPresetId: null,
    contextPresetId: null, instructPresetId: null, systemPresetId: null,
  })),
  http.post('/api/providers/probe', () => HttpResponse.json({ ok: true, modelCount: 2 })),
  http.post('/api/providers/models', () => HttpResponse.json({
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro', ownedBy: 'deepseek' }],
  })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => localStorage.setItem('tavernnext.language', 'en'));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe('ConnectionPage', () => {
  it('shows how to recover after an active selection was cleared by deletion', async () => {
    server.use(http.get('/api/settings/generation', () => HttpResponse.json({
      id: '018f0000-0000-7000-8000-000000000001', revision: 2,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T01:00:00.000Z',
      providerId: null, chatPresetId: null, textPresetId: null,
      contextPresetId: null, instructPresetId: null, systemPresetId: null,
      selectionNotice: {
        kind: 'provider', deletedId: '018f0000-0000-7000-8000-000000000201', createdAt: '2026-08-17T01:00:00.000Z',
      },
    })));
    renderWithApp(<ConnectionPage />);

    expect(await screen.findByText(
      'The active Provider was cleared after deletion. Choose a replacement and save.',
    )).not.toBeNull();
  });

  it('selects and saves only the active Provider behind the loaded revision', async () => {
    const provider = {
      id: '018f0000-0000-7000-8000-000000000201', revision: 0,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      name: 'Global API', providerId: 'openai', modelId: 'gpt-agent',
      baseUrl: 'https://api.openai.com/v1', toolCalls: true, hasApiKey: true,
    };
    let submitted: unknown;
    server.use(
      http.get('/api/providers', () => HttpResponse.json([provider])),
      http.patch('/api/settings/generation', async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json({
          id: '018f0000-0000-7000-8000-000000000001', revision: 1,
          createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T01:00:00.000Z',
          providerId: provider.id,
          chatPresetId: null, textPresetId: null, contextPresetId: null,
          instructPresetId: null, systemPresetId: null,
        });
      }),
    );
    const user = userEvent.setup();
    renderWithApp(<ConnectionPage />);

    await screen.findByRole('option', { name: 'Global API' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Active Provider' }), provider.id);
    expect(screen.queryByLabelText('Chat preset')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save active Provider' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save active Provider' }));

    await waitFor(() => expect(submitted).toEqual({
      revision: 0,
      patch: { providerId: provider.id },
    }));
    expect(await screen.findByText('Active Provider saved.')).not.toBeNull();
  });

  it('drives Provider/model selection from Pi metadata and explains unavailable authentication', async () => {
    let submitted: Record<string, unknown> | undefined;
    server.use(http.post('/api/providers', async ({ request }) => {
      submitted = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...submitted, revision: 0, createdAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-17T00:00:00.000Z', baseUrl: 'https://api.openai.com/v1', hasApiKey: true,
      }, { status: 201 });
    }));
    const user = userEvent.setup();
    renderWithApp(<ConnectionPage />);

    await screen.findByRole('option', { name: 'OpenAI' });
    expect(screen.getByText(/Subscription login is not supported yet/)).not.toBeNull();
    expect(screen.getByText(/composite cloud credentials/)).not.toBeNull();
    expect((screen.getByRole('option', { name: 'OpenAI Codex — Unavailable' }) as HTMLOptionElement).disabled).toBe(true);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'openai');
    expect((screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe('OpenAI');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'gpt-agent-mini');
    expect(screen.queryByRole('textbox', { name: 'Base URL' })).toBeNull();
    expect(screen.queryByLabelText('Mode')).toBeNull();
    await user.type(screen.getByLabelText('API key'), 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(submitted).toMatchObject({
      name: 'OpenAI', providerId: 'openai', modelId: 'gpt-agent-mini', apiKey: 'new-secret',
    }));
    expect(submitted).not.toHaveProperty('apiMode');
    expect(submitted).not.toHaveProperty('baseUrl');
  });

  it('switches, updates, and creates independently saved connections', async () => {
    const primary = {
      id: '018f0000-0000-7000-8000-000000000101', revision: 0,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      name: 'Primary API', providerId: 'custom-openai-compatible', modelId: 'primary-model',
      baseUrl: 'https://primary.example/v1', customBaseUrl: 'https://primary.example/v1', toolCalls: true, hasApiKey: true,
    };
    const backup = {
      id: '018f0000-0000-7000-8000-000000000102', revision: 0,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      name: 'Backup API', providerId: 'custom-openai-compatible', modelId: 'backup-model',
      baseUrl: 'https://backup.example/v1', customBaseUrl: 'https://backup.example/v1', toolCalls: true, hasApiKey: false,
    };
    let stored = [primary, backup];
    let updatedId: string | undefined;
    let createdApiKey: string | undefined;
    server.use(
      http.get('/api/providers', () => HttpResponse.json(stored)),
      http.patch('/api/providers/:id', async ({ params, request }) => {
        const body = await request.json() as { patch: Partial<typeof backup> };
        updatedId = String(params.id);
        const current = stored.find((provider) => provider.id === updatedId)!;
        const updated = { ...current, ...body.patch, revision: current.revision + 1 };
        stored = stored.map((provider) => provider.id === updated.id ? updated : provider);
        return HttpResponse.json(updated);
      }),
      http.post('/api/providers', async ({ request }) => {
        const body = await request.json() as typeof primary & { apiKey?: string };
        createdApiKey = body.apiKey;
        const created = { ...body, revision: 0, createdAt: primary.createdAt, updatedAt: primary.updatedAt, hasApiKey: body.apiKey !== undefined };
        stored = [...stored, created];
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithApp(<ConnectionPage />);

    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe('Primary API'));
    expect(screen.getByText('2 saved connections')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    expect((screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Edit Backup API connection' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://backup.example/v1'));
    const model = screen.getByRole('combobox', { name: 'Model' });
    await user.clear(model);
    await user.type(model, 'backup-model-v2');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(updatedId).toBe(backup.id));
    expect(stored[0]?.modelId).toBe('primary-model');
    expect(stored[1]?.modelId).toBe('backup-model-v2');

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'Local custom');
    await user.type(screen.getByRole('combobox', { name: 'Model' }), 'local-model');
    await user.click(screen.getByLabelText('Model supports tool calls'));
    await user.type(screen.getByLabelText('API key'), 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));

    expect(await screen.findByRole('button', { name: 'Edit Local custom connection' })).not.toBeNull();
    expect(createdApiKey).toBe('new-secret');
    expect(stored).toHaveLength(3);
    expect(stored[2]?.toolCalls).toBe(true);
  });
});
