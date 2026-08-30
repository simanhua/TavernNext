// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneReferenceKind } from '@tavernnext/domain';
import { renderWithApp } from '../../test/render.js';
import { SceneReferenceTools } from './SceneReferenceTools.js';
import { SceneReferenceViewer } from './SceneReferenceViewer.js';

const conversationId = '018f0000-0000-7000-8000-000000000921';
const chatPresetId = '018f0000-0000-7000-8000-000000000926';
const textPresetId = '018f0000-0000-7000-8000-000000000927';
const now = '2026-08-29T00:00:00.000Z';
const configuration = {
  id: '018f0000-0000-7000-8000-000000000922', revision: 3, createdAt: now, updatedAt: now,
  conversationId, sourcePresetId: null, sourcePresetRevision: null,
  name: 'Private narrator', settings: {
    temperature: 0.7,
    prompts: [
      { identifier: 'support', name: 'Support prompt', role: 'system', content: 'Support the scene.', enabled: true },
      { identifier: 'main', name: 'Main prompt', role: 'system', content: 'Direct the scene.', enabled: true },
    ],
    prompt_order: [{ character_id: 100000, order: [
      { identifier: 'main', enabled: true }, { identifier: 'support', enabled: true },
    ] }],
  },
};
const worldbookEntry = {
  id: '018f0000-0000-7000-8000-000000000924', worldbookId: '018f0000-0000-7000-8000-000000000923',
  revision: 0, createdAt: now, updatedAt: now, sourceOrdinal: 0, displayName: 'The Gate',
  comment: '', keys: ['gate'], enabled: false, effectiveEnabled: true,
  activationSource: 'save' as const, saveOverrideEnabled: true, contentOverridden: true,
  effectiveContent: 'The Save opens the gate at dusk.', constant: false, order: 0,
  content: 'The gate opens only at dawn.',
};
const worldbook = {
  id: '018f0000-0000-7000-8000-000000000923', revision: 0, createdAt: now, updatedAt: now,
  name: 'Archive Lore', description: 'Rules of the archive.', enabled: true,
  scanDepth: 4, tokenBudget: 512, recursiveScanning: true, isGlobal: false,
  entries: [worldbookEntry],
};
let savedDescription: string | undefined;
let replacedPreset: unknown;

const server = setupServer(
  http.get('/api/presets', () => HttpResponse.json([
    { id: chatPresetId, revision: 2, name: 'Imported narrator', kind: 'chat' },
    { id: textPresetId, revision: 1, name: 'Imported text completion', kind: 'text' },
  ])),
  http.get(`/api/conversations/${conversationId}/runtime-references`, () => HttpResponse.json({
    configuration,
    worldbooks: [{
      source: 'character',
      saveOwned: true,
      templateLineage: { worldbookId: '018f0000-0000-7000-8000-000000000925', revision: 0 },
      value: worldbook,
    }],
  })),
  http.post(`/api/conversations/${conversationId}/agent-configuration/replace`, async ({ request }) => {
    replacedPreset = await request.json();
    return HttpResponse.json({
      ...configuration,
      revision: 4,
      sourcePresetId: chatPresetId,
      sourcePresetRevision: 2,
      name: 'Imported narrator',
      settings: { temperature: 0.3, prompts: [], prompt_order: [] },
    });
  }),
  http.patch(`/api/conversations/${conversationId}/runtime-references/preset-prompts/:identifier`, async ({ params, request }) => {
    const body = await request.json() as { enabled: boolean };
    const identifier = String(params.identifier);
    return HttpResponse.json({
      ...configuration,
      revision: 4,
      settings: {
        ...configuration.settings,
        prompts: configuration.settings.prompts.map((prompt) => prompt.identifier === identifier ? { ...prompt, enabled: body.enabled } : prompt),
        prompt_order: configuration.settings.prompt_order.map((group) => ({
          ...group,
          order: group.order.map((entry) => entry.identifier === identifier ? { ...entry, enabled: body.enabled } : entry),
        })),
      },
    });
  }),
  http.patch(`/api/conversations/${conversationId}/runtime-references/worldbooks/:worldbookId`, async ({ request }) => {
    const body = await request.json() as { enabled: boolean };
    return HttpResponse.json({ ...worldbook, revision: 1, enabled: body.enabled });
  }),
  http.patch(`/api/conversations/${conversationId}/runtime-references/worldbooks/:worldbookId/entries/:entryId`, async ({ request }) => {
    const body = await request.json() as { enabled: boolean };
    return HttpResponse.json({ ...worldbookEntry, revision: 1, enabled: body.enabled });
  }),
  http.patch(`/api/conversations/${conversationId}/save-worldbook/:worldbookId`, async ({ request }) => {
    const body = await request.json() as { patch: { description: string } };
    savedDescription = body.patch.description;
    return HttpResponse.json({ ...worldbook, ...body.patch, revision: 1 });
  }),
);

function Host() {
  const [kind, setKind] = useState<SceneReferenceKind | undefined>('preset');
  return kind === undefined ? <p>closed</p> : (
    <SceneReferenceViewer
      conversationId={conversationId}
      kind={kind}
      onKindChange={setKind}
      onClose={() => setKind(undefined)}
    />
  );
}

function pointer(target: Element, type: string, values: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  fireEvent(target, event);
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  localStorage.setItem('tavernnext.language', 'en');
  savedDescription = undefined;
  replacedPreset = undefined;
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe('SceneReferenceViewer', () => {
  it('switches this Save copy to any imported Chat Preset and exposes unsupported Preset families as unavailable', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApp(<Host />);

    await screen.findByText('Private narrator');
    const chatOption = screen.getByRole('option', { name: 'Imported narrator · chat' });
    const textOption = screen.getByRole('option', { name: 'Imported text completion · text' });
    expect(chatOption.hasAttribute('disabled')).toBe(false);
    expect(textOption.hasAttribute('disabled')).toBe(true);

    await user.selectOptions(screen.getByLabelText('Preset for this Save'), chatPresetId);
    await user.click(screen.getByRole('button', { name: 'Switch Save Preset' }));

    await waitFor(() => expect(replacedPreset).toEqual({ revision: 3, presetId: chatPresetId }));
    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByText('Imported narrator')).not.toBeNull();
  });

  it('shows the effective Save Preset and Save-owned Worldbook controls in one viewer', async () => {
    const user = userEvent.setup();
    renderWithApp(<Host />);

    expect(await screen.findByText('Private narrator')).not.toBeNull();
    expect([...document.querySelectorAll('.scene-reference-preset-list > details > summary > span:first-of-type')].map((node) => node.textContent))
      .toEqual(['Main prompt', 'Support prompt']);
    const prompt = screen.getByText('Main prompt').closest('details');
    expect(prompt?.open).toBe(false);
    await user.click(screen.getByRole('switch', { name: 'Disable prompt Main prompt' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable prompt Main prompt' }).getAttribute('aria-checked')).toBe('false'));
    expect(prompt?.open).toBe(false);
    await user.click(screen.getByText('Main prompt'));
    expect(prompt?.open).toBe(true);
    expect(screen.getByText('Direct the scene.')).not.toBeNull();
    expect(screen.getByText(/"temperature": 0.7/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Worldbooks' }));
    expect(await screen.findByText('Archive Lore')).not.toBeNull();
    const book = screen.getByText('Archive Lore').closest('details');
    const entry = screen.getByText('The Gate').closest('details');
    expect(entry?.dataset.enabled).toBe('true');
    expect(screen.getByText('Save copy: Enabled')).not.toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Disable Save Worldbook Archive Lore' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Save Worldbook Archive Lore' }).getAttribute('aria-checked')).toBe('false'));
    expect(book?.open).toBe(false);
    await user.click(screen.getByText('Archive Lore'));
    expect(entry?.open).toBe(false);
    expect(screen.getByText('Save copy: Disabled')).not.toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Enable Save Worldbook entry The Gate' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Disable Save Worldbook entry The Gate' }).getAttribute('aria-checked')).toBe('true'));
    await user.click(screen.getByRole('switch', { name: 'Enable Save Worldbook Archive Lore' }));
    await waitFor(() => expect(entry?.dataset.enabled).toBe('true'));
    expect(entry?.open).toBe(false);
    await user.click(screen.getByText('The Gate'));
    expect(entry?.open).toBe(true);
    expect(screen.getByText('The Save opens the gate at dusk.')).not.toBeNull();
    expect(screen.getByText('Content materialized for this Save')).not.toBeNull();
    expect(screen.getByText(/Save-owned Worldbook/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close runtime references' }));
    expect(screen.getByText('closed')).not.toBeNull();
  });

  it('opens the Save-owned Worldbook editor and persists book settings through the scoped route', async () => {
    const user = userEvent.setup();
    renderWithApp(<Host />);
    await screen.findByText('Private narrator');
    await user.click(screen.getByRole('button', { name: 'Worldbooks' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Edit Save Worldbook' })).not.toBeNull();
    const description = screen.getByLabelText('Worldbook description');
    await user.clear(description);
    await user.type(description, 'Rules owned by this Save only.');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook' }));
    await waitFor(() => expect(savedDescription).toBe('Rules owned by this Save only.'));
    expect(screen.getByText(/independent Save copy/)).not.toBeNull();
  });

  it('moves the floating viewer by dragging its title bar and keeps it inside the viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    renderWithApp(<Host />);
    await screen.findByText('Private narrator');
    const dialog = screen.getByRole('dialog');
    Object.defineProperty(dialog, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 500, top: 20, width: 600, height: 700, right: 1_100, bottom: 720, x: 500, y: 20, toJSON() {} }),
    });
    const handle = dialog.querySelector<HTMLElement>('.scene-reference-drag-handle')!;

    pointer(handle, 'pointerdown', { button: 0, pointerId: 7, clientX: 560, clientY: 40 });
    pointer(handle, 'pointermove', { pointerId: 7, clientX: 210, clientY: 140 });

    expect(dialog.style.left).toBe('150px');
    expect(dialog.style.top).toBe('120px');
  });

  it('fuzzy searches Preset prompts and Worldbook entries independently', async () => {
    const user = userEvent.setup();
    renderWithApp(<Host />);
    await screen.findByText('Private narrator');
    const presetSearch = screen.getByPlaceholderText('Search Preset entries…');

    await user.type(presetSearch, 'mnpt');
    expect(screen.getByText('Main prompt')).not.toBeNull();
    expect(screen.queryByText('Support prompt')).toBeNull();
    expect(screen.getByText('1 of 2')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Worldbooks' }));
    const worldbookSearch = screen.getByPlaceholderText('Search Worldbooks and entries…');
    await user.type(worldbookSearch, 'gtdn');
    expect(screen.getByText('Archive Lore')).not.toBeNull();
    expect(screen.getByText('The Gate')).not.toBeNull();
    await user.clear(worldbookSearch);
    await user.type(worldbookSearch, 'no-such-lore');
    expect(screen.getByText('No matching Worldbooks or entries.')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Preset' }));
    expect((screen.getByPlaceholderText('Search Preset entries…') as HTMLInputElement).value).toBe('mnpt');
  });

  it('drags the reference button group without triggering the button action', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    const onOpen = vi.fn();
    renderWithApp(<SceneReferenceTools onOpen={onOpen} />);
    const tools = screen.getByRole('navigation', { name: 'Runtime references' });
    const preset = screen.getByRole('button', { name: 'View Preset' });
    Object.defineProperty(tools, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 900, top: 20, width: 280, height: 60, right: 1_180, bottom: 80, x: 900, y: 20, toJSON() {} }),
    });
    let captureTarget: Element | undefined;
    Object.defineProperty(tools, 'setPointerCapture', { configurable: true, value: () => { captureTarget = tools; } });
    Object.defineProperty(preset, 'setPointerCapture', { configurable: true, value: () => { captureTarget = preset; } });
    Object.defineProperty(tools, 'releasePointerCapture', { configurable: true, value: () => undefined });
    Object.defineProperty(preset, 'releasePointerCapture', { configurable: true, value: () => undefined });

    pointer(preset, 'pointerdown', { button: 0, pointerId: 8, clientX: 950, clientY: 40 });
    pointer(captureTarget ?? preset, 'pointerup', { pointerId: 8, clientX: 950, clientY: 40 });
    fireEvent.click(captureTarget ?? preset);
    expect(onOpen).toHaveBeenCalledTimes(1);
    captureTarget = undefined;
    pointer(preset, 'pointerdown', { button: 0, pointerId: 9, clientX: 950, clientY: 40 });
    pointer(captureTarget ?? preset, 'pointermove', { pointerId: 9, clientX: 450, clientY: 140 });
    pointer(captureTarget ?? preset, 'pointerup', { pointerId: 9, clientX: 450, clientY: 140 });
    fireEvent.click(preset);

    expect(tools.style.left).toBe('400px');
    expect(tools.style.top).toBe('120px');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
