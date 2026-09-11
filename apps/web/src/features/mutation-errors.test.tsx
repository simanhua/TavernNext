// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../app/i18n.js';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionPage } from './settings/ConnectionPage.js';

const server = setupServer(
  http.get('/api/providers', () => HttpResponse.json([])),
  http.get('/api/providers/catalog', () => HttpResponse.json([{
    id: 'custom-openai-compatible', name: 'Custom OpenAI-compatible', authentication: 'api_key',
    available: true, customBaseUrl: true, credentialLabel: 'API key', models: [],
  }])),
  http.get('/api/presets', () => HttpResponse.json([])),
  http.get('/api/settings/generation', () => HttpResponse.json({
    revision: 0, providerId: null, chatPresetId: null, textPresetId: null,
    contextPresetId: null, instructPresetId: null, systemPresetId: null,
  })),
  http.post('/api/providers', () => HttpResponse.error()),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => cleanup());
afterAll(() => server.close());

function renderWithQuery(component: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<I18nProvider><QueryClientProvider client={queryClient}>{component}</QueryClientProvider></I18nProvider>);
}

describe('mutation error feedback', () => {
  it('reports Connection save network failure', async () => {
    const user = userEvent.setup();
    renderWithQuery(<ConnectionPage />);
    await user.type(screen.getByLabelText('Display name'), 'Local');
    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'http://127.0.0.1:8080/v1');
    await user.type(screen.getByLabelText('Model'), 'mock');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to save connection');
  });

});
