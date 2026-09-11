// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { RouterProvider, createMemoryRouter, matchRoutes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appRoutes } from './router.js';
import { I18nProvider } from './i18n.js';
import { ThemeProvider } from './theme.js';

const server = setupServer(
  http.get('/api/personas', () => HttpResponse.json([])),
  http.get('/api/presets', () => HttpResponse.json([])),
  http.get('/api/providers', () => HttpResponse.json([])),
  http.get('/api/providers/catalog', () => HttpResponse.json([])),
  http.get('/api/scenes', () => HttpResponse.json([])),
  http.get('/api/scenes/catalog', () => HttpResponse.json([])),
  http.get('/api/settings/generation', () => HttpResponse.json({
    id: '018f0000-0000-7000-8000-000000000001', revision: 0,
    providerId: null, chatPresetId: null, textPresetId: null,
    contextPresetId: null, instructPresetId: null, systemPresetId: null, selectionNotice: null,
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
    expect(screen.getByRole('button', { name: 'Chat 模板' })).not.toBeNull();
  });

  it('retires legacy destinations while retaining Scene setup and Save routes', () => {
    for (const path of ['/legacy-chat', '/chat', '/characters', '/worldbooks', '/imports']) {
      expect(matchRoutes(appRoutes, path)).toBeNull();
    }
    expect(matchRoutes(appRoutes, '/scene-runtime/example/new')?.at(-1)?.route.path).toBe('/scene-runtime/:sceneId/new');
    expect(matchRoutes(appRoutes, '/scene-runtime/example/conversations/save-id')?.at(-1)?.route.path).toBe('/scene-runtime/:sceneId/conversations/:conversationId');
  });
});
