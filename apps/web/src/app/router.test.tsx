// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appRoutes } from './router.js';
import { I18nProvider } from './i18n.js';
import { ThemeProvider } from './theme.js';

const server = setupServer(
  http.get('/api/characters', () => HttpResponse.json([])),
  http.get('/api/personas', () => HttpResponse.json([])),
  http.get('/api/presets', () => HttpResponse.json([])),
  http.get('/api/worldbooks', () => HttpResponse.json([])),
  http.get('/api/providers', () => HttpResponse.json([])),
  http.get('/api/providers/catalog', () => HttpResponse.json([])),
  http.get('/api/conversations', () => HttpResponse.json([])),
  http.get('/api/scenes', () => HttpResponse.json([])),
  http.get('/api/scenes/catalog', () => HttpResponse.json([])),
  http.get('/api/settings/generation', () => HttpResponse.json({
    id: '018f0000-0000-7000-8000-000000000001', revision: 0,
    providerId: null, chatPresetId: null, textPresetId: null,
    contextPresetId: null, instructPresetId: null, systemPresetId: null, selectionNotice: null,
  })),
  http.get('/api/settings/generation/active-resource-context', () => HttpResponse.json({
    globalGenerationConfigRevision: 0, mode: null, primaryPreset: null,
    conversation: null, character: null, owners: [],
  })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => cleanup());
afterAll(() => server.close());

describe('application routes', () => {
  it('uses the Scene library and unified settings as the primary product destinations', async () => {
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/'] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<ThemeProvider><I18nProvider><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></I18nProvider></ThemeProvider>);

    expect(await screen.findByRole('heading', { name: '角色卡' })).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Worldbooks' })).toBeNull();
    expect(screen.getByRole('link', { name: '设置' })).not.toBeNull();
    await router.navigate('/settings');
    expect(await screen.findByRole('heading', { name: '设置' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Persona 模板' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '全局回退预设' })).not.toBeNull();
  });

  it('keeps recovered legacy chats available outside the primary navigation', async () => {
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/legacy-chat'] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<ThemeProvider><I18nProvider><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></I18nProvider></ThemeProvider>);

    expect(await screen.findByRole('combobox', { name: /Conversation|对话/ })).not.toBeNull();
    expect(screen.queryByRole('link', { name: /Legacy chat|旧版聊天/ })).toBeNull();
  });
});
