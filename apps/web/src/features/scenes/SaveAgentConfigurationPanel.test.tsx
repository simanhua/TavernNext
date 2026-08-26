// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { SaveAgentConfigurationPanel } from './SaveAgentConfigurationPanel.js';

const conversationId = '018f0000-0000-7000-8000-000000000701';
const sourcePresetId = '018f0000-0000-7000-8000-000000000702';
const alternatePresetId = '018f0000-0000-7000-8000-000000000703';
const now = '2026-08-26T00:00:00.000Z';
let configuration = {
  id: '018f0000-0000-7000-8000-000000000704', revision: 0, createdAt: now, updatedAt: now,
  conversationId, sourcePresetId, sourcePresetRevision: 0,
  name: 'Scene style', settings: { temperature: 0.7, prompts: [], prompt_order: [] },
};
let patched: unknown;
let replaced: unknown;
let synchronized: unknown;

const server = setupServer(
  http.get(`/api/conversations/${conversationId}/agent-configuration`, () => HttpResponse.json(configuration)),
  http.get('/api/presets', () => HttpResponse.json([
    { id: sourcePresetId, revision: 1, name: 'Scene style latest', kind: 'chat' },
    { id: alternatePresetId, revision: 0, name: 'Alternate style', kind: 'chat' },
    { id: '018f0000-0000-7000-8000-000000000705', revision: 0, name: 'Text preset', kind: 'text' },
  ])),
  http.patch(`/api/conversations/${conversationId}/agent-configuration`, async ({ request }) => {
    patched = await request.json();
    configuration = { ...configuration, ...(patched as { patch: object }).patch, revision: 1 };
    return HttpResponse.json(configuration);
  }),
  http.post(`/api/conversations/${conversationId}/agent-configuration/replace`, async ({ request }) => {
    replaced = await request.json();
    configuration = {
      ...configuration, revision: 2, sourcePresetId: alternatePresetId, sourcePresetRevision: 0,
      name: 'Alternate style', settings: { temperature: 0.4, prompts: [], prompt_order: [] },
    };
    return HttpResponse.json(configuration);
  }),
  http.post(`/api/conversations/${conversationId}/agent-configuration/sync`, async ({ request }) => {
    synchronized = await request.json();
    configuration = { ...configuration, revision: 3, sourcePresetRevision: 1, name: 'Alternate style latest' };
    return HttpResponse.json(configuration);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  localStorage.setItem('tavernnext.language', 'en');
  configuration = {
    id: '018f0000-0000-7000-8000-000000000704', revision: 0, createdAt: now, updatedAt: now,
    conversationId, sourcePresetId, sourcePresetRevision: 0,
    name: 'Scene style', settings: { temperature: 0.7, prompts: [], prompt_order: [] },
  };
  patched = undefined;
  replaced = undefined;
  synchronized = undefined;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('SaveAgentConfigurationPanel', () => {
  it('saves a private draft, replaces its Chat template, and confirms destructive synchronization', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApp(<SaveAgentConfigurationPanel conversationId={conversationId} />);

    expect(await screen.findByDisplayValue('Scene style')).not.toBeNull();
    expect(screen.queryByRole('option', { name: 'Text preset' })).toBeNull();
    await user.clear(screen.getByLabelText('Preset name'));
    await user.type(screen.getByLabelText('Preset name'), 'Private style');
    fireEvent.change(screen.getByLabelText('Executable settings JSON'), {
      target: { value: '{"temperature":0.2,"prompts":[],"prompt_order":[]}' },
    });
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => expect(patched).toEqual({
      revision: 0,
      patch: { name: 'Private style', settings: { temperature: 0.2, prompts: [], prompt_order: [] } },
    }));
    await user.selectOptions(screen.getByLabelText('Template'), alternatePresetId);
    await user.click(screen.getByRole('button', { name: 'Replace from template' }));
    await waitFor(() => expect(replaced).toEqual({ revision: 1, presetId: alternatePresetId }));
    await user.click(screen.getByRole('button', { name: 'Synchronize template' }));
    await waitFor(() => expect(synchronized).toEqual({ revision: 2 }));
    expect(window.confirm).toHaveBeenCalled();
  });
});
