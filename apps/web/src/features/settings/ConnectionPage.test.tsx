// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { ConnectionPage } from './ConnectionPage.js';

const server = setupServer(
  http.get('/api/providers', () => HttpResponse.json([])),
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
        kind: 'preset', deletedId: '018f0000-0000-7000-8000-000000000202', createdAt: '2026-08-17T01:00:00.000Z',
      },
    })));
    renderWithApp(<ConnectionPage />);

    expect(await screen.findByText(
      'An active preset selection was cleared after deletion. Choose a replacement and save.',
    )).not.toBeNull();
  });

  it('persists every global generation selection behind the loaded revision', async () => {
    const provider = {
      id: '018f0000-0000-7000-8000-000000000201', revision: 0,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      name: 'Global API', baseUrl: 'https://global.example/v1', model: 'global-model', apiMode: 'chat' as const, hasApiKey: true,
    };
    const presets = [
      { id: '018f0000-0000-7000-8000-000000000202', revision: 0, name: 'Chat Main', kind: 'chat' },
      { id: '018f0000-0000-7000-8000-000000000203', revision: 0, name: 'Text Main', kind: 'text' },
      { id: '018f0000-0000-7000-8000-000000000204', revision: 0, name: 'Context Main', kind: 'context' },
      { id: '018f0000-0000-7000-8000-000000000205', revision: 0, name: 'Instruct Main', kind: 'instruct' },
      { id: '018f0000-0000-7000-8000-000000000206', revision: 0, name: 'System Main', kind: 'system' },
    ];
    let submitted: unknown;
    server.use(
      http.get('/api/providers', () => HttpResponse.json([provider])),
      http.get('/api/presets', () => HttpResponse.json(presets)),
      http.patch('/api/settings/generation', async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json({
          id: '018f0000-0000-7000-8000-000000000001', revision: 1,
          createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T01:00:00.000Z',
          providerId: provider.id,
          chatPresetId: presets[0]!.id,
          textPresetId: presets[1]!.id,
          contextPresetId: presets[2]!.id,
          instructPresetId: presets[3]!.id,
          systemPresetId: presets[4]!.id,
        });
      }),
    );
    const user = userEvent.setup();
    renderWithApp(<ConnectionPage />);

    await screen.findByRole('option', { name: 'Global API' });
    await user.selectOptions(screen.getByLabelText('Active Provider'), provider.id);
    expect((screen.getByRole('button', { name: 'Save active generation configuration' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Select a Chat Preset for the active Chat Provider.')).not.toBeNull();
    await user.selectOptions(screen.getByLabelText('Chat Preset'), presets[0]!.id);
    await user.selectOptions(screen.getByLabelText('Text Preset'), presets[1]!.id);
    await user.selectOptions(screen.getByLabelText('Context Preset'), presets[2]!.id);
    await user.selectOptions(screen.getByLabelText('Instruct Preset'), presets[3]!.id);
    await user.selectOptions(screen.getByLabelText('System Preset'), presets[4]!.id);
    expect((screen.getByRole('button', { name: 'Save active generation configuration' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save active generation configuration' }));

    await waitFor(() => expect(submitted).toEqual({
      revision: 0,
      patch: {
        providerId: provider.id,
        chatPresetId: presets[0]!.id,
        textPresetId: presets[1]!.id,
        contextPresetId: presets[2]!.id,
        instructPresetId: presets[3]!.id,
        systemPresetId: presets[4]!.id,
      },
    }));
    expect(await screen.findByText('Active generation configuration saved.')).not.toBeNull();
  });

  it('applies provider presets, tests the connection, and selects a detected model', async () => {
    const user = userEvent.setup();
    renderWithApp(<ConnectionPage />);

    await user.click(await screen.findByRole('button', { name: 'Use DeepSeek preset' }));
    expect((screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe('DeepSeek');
    expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://api.deepseek.com');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).value).toBe('deepseek-v4-flash');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection successful. 2 models available.')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Detect models' }));
    await user.click(await screen.findByRole('button', { name: 'deepseek-v4-pro' }));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).value).toBe('deepseek-v4-pro'));

    await user.click(screen.getByRole('button', { name: 'Use OpenCode Zen preset' }));
    expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://opencode.ai/zen/v1');

    await user.click(screen.getByRole('button', { name: 'Use OpenCode Go preset' }));
    expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://opencode.ai/zen/go/v1');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).value).toBe('deepseek-v4-flash');
  });

  it('switches, updates, and creates independently saved connections', async () => {
    const primary = {
      id: '018f0000-0000-7000-8000-000000000101', revision: 0,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      name: 'Primary API', baseUrl: 'https://primary.example/v1', model: 'primary-model', apiMode: 'chat' as const, hasApiKey: true,
    };
    const backup = {
      id: '018f0000-0000-7000-8000-000000000102', revision: 0,
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
      name: 'Backup API', baseUrl: 'https://backup.example/v1', model: 'backup-model', apiMode: 'chat' as const, hasApiKey: false,
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
    expect(stored[0]?.model).toBe('primary-model');
    expect(stored[1]?.model).toBe('backup-model-v2');

    await user.click(screen.getByRole('button', { name: 'Use DeepSeek preset' }));
    expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://api.deepseek.com');
    await user.type(screen.getByLabelText('API key'), 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));

    expect(await screen.findByRole('button', { name: 'Edit DeepSeek connection' })).not.toBeNull();
    expect(createdApiKey).toBe('new-secret');
    expect(stored).toHaveLength(3);
  });
});
