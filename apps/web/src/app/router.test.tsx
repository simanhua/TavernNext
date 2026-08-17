// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appRoutes } from './router.js';
import { I18nProvider } from './i18n.js';

const server = setupServer(
  http.get('/api/characters', () => HttpResponse.json([])),
  http.get('/api/personas', () => HttpResponse.json([])),
  http.get('/api/presets', () => HttpResponse.json([])),
  http.get('/api/worldbooks', () => HttpResponse.json([])),
  http.get('/api/providers', () => HttpResponse.json([])),
  http.get('/api/conversations', () => HttpResponse.json([])),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => cleanup());
afterAll(() => server.close());

describe('application routes', () => {
  it('navigates to all six final MVP destinations', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/characters'] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<I18nProvider><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></I18nProvider>);

    const destinations = [
      ['Chat', 'New conversation'],
      ['Characters', 'Characters'],
      ['Personas', 'Personas'],
      ['Presets', 'Presets'],
      ['Worldbooks', 'Worldbooks'],
      ['Connection Settings', 'Connection'],
    ] as const;
    for (const [linkName, headingName] of destinations) {
      const link = screen.getByRole('link', { name: linkName });
      expect(link).not.toBeNull();
      await user.click(link);
      expect(await screen.findByRole('heading', { name: headingName })).not.toBeNull();
    }
  });
});
