// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { PresetManagerPage } from './PresetManagerPage.js';

const now = '2026-08-08T00:00:00.000Z';
const ids = ['chat', 'text', 'context', 'instruct', 'system', 'reasoning'].map((kind, index) => ({
  id: `018f0000-0000-7000-8000-00000000092${index}`,
  revision: 0,
  name: `${kind[0]!.toUpperCase()}${kind.slice(1)} preset`,
  kind,
}));
let chatDetail = {
  ...ids[0], createdAt: now, updatedAt: now,
  settings: {
    temperature: 0.7,
    send_if_empty: 'Keep this fallback',
    prompts: [
      {
        identifier: 'main', name: 'Main', role: 'system', content: 'Main prompt', enabled: true,
        system_prompt: true, marker: false, injection_position: 1, injection_depth: 2, injection_order: 250,
        forbid_overrides: true, injection_trigger: ['continue'], generation_trigger: ['normal', 'regenerate'],
      },
      { identifier: 'jailbreak', name: 'Post history', role: 'system', content: 'Stay in character', enabled: true, marker: false },
    ],
    prompt_order: [{ character_id: 100000 as number | string, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }] }],
    __tavernnextPresetSource: { token: 'must-not-render' },
    provider_api_key: 'must-not-render-secret',
  },
  compatibilitySummary: {
    sourceFormat: 'preset:chat', warnings: ['provider_field_preserved_not_executable'], unknownFieldCount: 7,
  },
};
let patchCalls = 0;
let conflictOnce = false;
let deleteCalls = 0;
let patchBodies: Array<{ revision: number; patch: Record<string, unknown> }> = [];

const server = setupServer(
  http.get('/api/presets', () => HttpResponse.json(ids)),
  http.get('/api/presets/:id', () => HttpResponse.json(chatDetail)),
  http.patch('/api/presets/:id', async ({ request }) => {
    patchCalls += 1;
    const body = await request.json() as { revision: number; patch: Record<string, unknown> };
    patchBodies.push(body);
    expect(JSON.stringify(body)).not.toContain('__tavernnextPresetSource');
    expect(JSON.stringify(body)).not.toContain('provider_api_key');
    if (conflictOnce) {
      conflictOnce = false;
      chatDetail = { ...chatDetail, revision: 4, name: 'Server preset name' };
      return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    }
    if (body.revision !== chatDetail.revision) return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    const settings = structuredClone(chatDetail.settings) as Record<string, unknown>;
    if (body.patch.settings !== undefined) {
      for (const [key, value] of Object.entries(body.patch.settings as Record<string, unknown>)) {
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
    }
    chatDetail = { ...chatDetail, ...body.patch, settings: settings as typeof chatDetail.settings, revision: body.revision + 1 };
    return HttpResponse.json(chatDetail);
  }),
  http.delete('/api/presets/:id', () => {
    deleteCalls += 1;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/presets/:id/export', () => new HttpResponse('{}', {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="preset.json"; filename*=UTF-8\'\'Role%20Chat.json',
    },
  })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  chatDetail = {
    ...ids[0], createdAt: now, updatedAt: now,
    settings: {
      temperature: 0.7,
      send_if_empty: 'Keep this fallback',
      prompts: [
        {
          identifier: 'main', name: 'Main', role: 'system', content: 'Main prompt', enabled: true,
          system_prompt: true, marker: false, injection_position: 1, injection_depth: 2, injection_order: 250,
          forbid_overrides: true, injection_trigger: ['continue'], generation_trigger: ['normal', 'regenerate'],
        },
        { identifier: 'jailbreak', name: 'Post history', role: 'system', content: 'Stay in character', enabled: true, marker: false },
      ],
      prompt_order: [{ character_id: 100000 as number | string, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }] }],
      __tavernnextPresetSource: { token: 'must-not-render' },
      provider_api_key: 'must-not-render-secret',
    },
    compatibilitySummary: {
      sourceFormat: 'preset:chat', warnings: ['provider_field_preserved_not_executable'], unknownFieldCount: 7,
    },
  };
  patchCalls = 0;
  conflictOnce = false;
  deleteCalls = 0;
  patchBodies = [];
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('PresetManagerPage', () => {
  it('lists every family, edits typed Chat prompts, and preserves stable prompt order without exposing private values', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    for (const kind of ['Chat', 'Text', 'Context', 'Instruct', 'System', 'Reasoning']) {
      expect(await screen.findByText(kind, { selector: '.kind-badge' })).not.toBeNull();
    }
    await user.click(screen.getByRole('button', { name: 'Edit preset Chat preset' }));

    expect(screen.getByLabelText('Temperature')).not.toBeNull();
    expect(screen.getByLabelText('Prompt 1 identifier')).not.toBeNull();
    expect(screen.getByLabelText('Prompt 1 content')).not.toBeNull();
    expect(screen.getByLabelText('Prompt 1 role')).not.toBeNull();
    expect(screen.getByText('preset:chat')).not.toBeNull();
    expect(screen.getByText('7 preserved fields')).not.toBeNull();
    expect(screen.queryByText('must-not-render')).toBeNull();
    expect(screen.queryByText('must-not-render-secret')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Move prompt 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Add prompt' }));
    await user.clear(screen.getByLabelText('Prompt 3 identifier'));
    await user.type(screen.getByLabelText('Prompt 3 identifier'), 'extra');
    await user.type(screen.getByLabelText('Prompt 3 name'), 'Extra');
    await user.type(screen.getByLabelText('Prompt 3 content'), 'Additional prompt');
    const temperature = screen.getByLabelText('Temperature');
    await user.clear(temperature);
    await user.type(temperature, '0.9');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(chatDetail.settings.temperature).toBe(0.9);
    expect(chatDetail.settings.prompts.map((prompt) => prompt.identifier)).toEqual(['jailbreak', 'main', 'extra']);
    expect(chatDetail.settings.prompt_order[0]!.order.map((prompt) => prompt.identifier)).toEqual(['jailbreak', 'main', 'extra']);
  });

  it('keeps the local Preset draft on 409 and exposes reload/retry choices', async () => {
    const user = userEvent.setup();
    conflictOnce = true;
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Local preset draft');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Server revision 4');
    expect((name as HTMLInputElement).value).toBe('Local preset draft');
    expect(screen.getByRole('button', { name: 'Reload server version' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry with server revision' })).not.toBeNull();
  });

  it('adopts the reloaded Preset revision so the next ordinary Save succeeds', async () => {
    const user = userEvent.setup();
    conflictOnce = true;
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Local stale name');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));
    await screen.findByText(/Server revision 4/);

    await user.click(screen.getByRole('button', { name: 'Reload server version' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Server preset name');
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Saved after Reload');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(chatDetail.name).toBe('Saved after Reload'));
    expect(patchBodies.map((body) => body.revision)).toEqual([0, 4]);
  });

  it('sends a minimal Preset patch when only the name changes', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Renamed only');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]!.patch).toEqual({ name: 'Renamed only' });
  });

  it('preserves every group-local order and enabled flag while editing the default prompt order', async () => {
    const user = userEvent.setup();
    chatDetail.settings.prompt_order = [
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: false }] },
      { character_id: 42, order: [{ identifier: 'jailbreak', enabled: false }, { identifier: 'main', enabled: true }] },
    ];
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    expect((screen.getByLabelText('Prompt order group 1 character ID') as HTMLInputElement).value).toBe('100000');
    expect((screen.getByLabelText('Prompt order group 2 character ID') as HTMLInputElement).value).toBe('42');
    await user.click(screen.getByRole('button', { name: 'Move prompt order group 2 item 1 down' }));
    await user.click(screen.getByLabelText('Prompt order group 2 item 2 enabled'));
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(chatDetail.settings.prompt_order).toEqual([
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: false }] },
      { character_id: 42, order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }] },
    ]);
    expect(Object.keys(patchBodies[0]!.patch.settings as Record<string, unknown>)).toEqual(['prompt_order']);
  });

  it('preserves numeric-string prompt order group IDs when editing the group', async () => {
    const user = userEvent.setup();
    chatDetail.settings.prompt_order = [
      { character_id: '42', order: [{ identifier: 'main', enabled: true }] },
    ];
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    expect((screen.getByLabelText('Prompt order group 1 character ID') as HTMLInputElement).value).toBe('42');
    await user.click(screen.getByLabelText('Prompt order group 1 item 1 enabled'));
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(chatDetail.settings.prompt_order).toEqual([
      { character_id: '42', order: [{ identifier: 'main', enabled: false }] },
    ]);
  });

  it('uses an explicit tombstone when clearing one executable setting', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    const editor = screen.getByLabelText('Executable settings JSON');
    expect((editor as HTMLTextAreaElement).value).toContain('send_if_empty');
    fireEvent.change(editor, { target: { value: '{}' } });
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect((patchBodies[0]!.patch.settings as Record<string, unknown>).send_if_empty).toBeNull();
    expect(chatDetail.settings).not.toHaveProperty('send_if_empty');
  });

  it('preserves an already-empty prompt order without issuing a patch', async () => {
    const user = userEvent.setup();
    chatDetail.settings.prompt_order = [];
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));
    await waitFor(() => expect(patchCalls).toBe(0));
    expect(chatDetail.settings.prompt_order).toEqual([]);
  });

  it('allows removing the final prompt order group', async () => {
    const user = userEvent.setup();
    chatDetail.settings.prompt_order = [
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
    ];
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.click(screen.getByRole('button', { name: 'Remove prompt order group 1' }));
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(chatDetail.settings.prompt_order).toEqual([]);
    expect(patchBodies[0]!.patch.settings).toMatchObject({ prompt_order: [] });
  });

  it('rejects non-record executable JSON and treats whitespace numeric values as omitted', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    fireEvent.change(screen.getByLabelText('Executable settings JSON'), { target: { value: '[]' } });
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));
    expect((await screen.findByRole('alert')).textContent).toContain('plain JSON object');
    expect(patchCalls).toBe(0);

    fireEvent.change(screen.getByLabelText('Executable settings JSON'), { target: { value: '{}' } });
    fireEvent.change(screen.getByLabelText('Prompt 1 injection depth'), { target: { value: '   ' } });
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));
    await waitFor(() => expect(patchCalls).toBe(1));
    expect(chatDetail.settings.prompts[0]).not.toHaveProperty('injection_depth');
  });

  it('edits every recognized executable Chat prompt field with typed values', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));

    expect((screen.getByLabelText('Prompt 1 system prompt') as HTMLSelectElement).value).toBe('true');
    expect((screen.getByLabelText('Prompt 1 marker') as HTMLSelectElement).value).toBe('false');
    expect((screen.getByLabelText('Prompt 1 injection position') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Prompt 1 injection depth') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Prompt 1 injection order') as HTMLInputElement).value).toBe('250');
    expect((screen.getByLabelText('Prompt 1 forbid overrides') as HTMLSelectElement).value).toBe('true');
    expect((screen.getByLabelText('Prompt 1 injection triggers') as HTMLInputElement).value).toBe('["continue"]');
    expect((screen.getByLabelText('Prompt 1 generation triggers') as HTMLInputElement).value).toBe('["normal","regenerate"]');

    await user.selectOptions(screen.getByLabelText('Prompt 1 marker'), 'true');
    await user.clear(screen.getByLabelText('Prompt 1 injection depth'));
    await user.type(screen.getByLabelText('Prompt 1 injection depth'), '4');
    await user.clear(screen.getByLabelText('Prompt 1 generation triggers'));
    fireEvent.change(screen.getByLabelText('Prompt 1 generation triggers'), { target: { value: '["continue","regenerate"]' } });
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(chatDetail.settings.prompts[0]).toMatchObject({
      system_prompt: true, marker: true, injection_position: 1, injection_depth: 4, injection_order: 250,
      forbid_overrides: true, injection_trigger: ['continue'], generation_trigger: ['continue', 'regenerate'],
    });
    expect(Object.keys(patchBodies[0]!.patch.settings as Record<string, unknown>)).toEqual(['prompts']);
  });

  it('announces an invalid temperature instead of silently blocking submit', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.clear(screen.getByLabelText('Temperature'));
    await user.type(screen.getByLabelText('Temperature'), 'hot');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Temperature must be a number');
    expect(patchCalls).toBe(0);
  });

  it('announces invalid typed Chat prompt fields instead of silently blocking submit', async () => {
    const user = userEvent.setup();
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.clear(screen.getByLabelText('Prompt 1 injection depth'));
    await user.type(screen.getByLabelText('Prompt 1 injection depth'), 'hot');
    await user.click(screen.getByRole('button', { name: 'Save Preset' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Optional numeric prompt fields must be numbers');
    expect(patchCalls).toBe(0);
  });

  it('exports by the server filename and deletes with the current revision', async () => {
    const user = userEvent.setup();
    let downloadedName = '';
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preset') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { downloadedName = this.download; });
    renderWithApp(<PresetManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit preset Chat preset' }));
    await user.click(screen.getByRole('button', { name: 'Export Preset' }));
    await waitFor(() => expect(downloadedName).toBe('Role Chat.json'));
    await user.click(screen.getByRole('button', { name: 'Delete Preset' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete Preset' }));
    await waitFor(() => expect(deleteCalls).toBe(1));
  });
});
