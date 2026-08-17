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
  http.post('/api/providers/probe', () => HttpResponse.json({ ok: true, modelCount: 2 })),
  http.post('/api/providers/models', () => HttpResponse.json({
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro', ownedBy: 'deepseek' }],
  })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => localStorage.setItem('tavernnext.language', 'en'));
afterEach(() => cleanup());
afterAll(() => server.close());

describe('ConnectionPage', () => {
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
});
