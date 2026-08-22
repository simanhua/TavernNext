// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import type { EditableExtensionAssetView } from '../../api/client.js';
import { ExtensionResourceManagerPage } from './ExtensionResourceManagerPage.js';

const characterId = '018f0000-0000-7000-8000-000000002201';
const presetId = '018f0000-0000-7000-8000-000000002202';
let conflictOnce = true;
let savedAssets: EditableExtensionAssetView[] = [];
let putCalls = 0;
let runtimeValue: Record<string, unknown> = { count: 1 };
let runtimeRevision = 0;

const presetAssets: EditableExtensionAssetView[] = [{
  kind: 'regex', sourceKey: 'regex-one', ordinal: 0, enabled: true, diagnostics: [],
  payload: { id: 'regex-one', scriptName: 'Preset regex', findRegex: '/x/g', replaceString: 'y' },
}, {
  kind: 'tavern_helper', sourceKey: 'script-one', ordinal: 0, enabled: true, diagnostics: [],
  payload: { id: 'script-one', type: 'script', name: 'Existing script', enabled: true, content: 'old();', info: '', button: {}, data: {}, export_with: {} },
}];
const opaqueAssets: EditableExtensionAssetView[] = [{
  kind: 'regex', sourceKey: 'opaque-regex', ordinal: 0, enabled: false,
  payload: 'opaque-regex', diagnostics: ['regex_not_object'],
}, {
  kind: 'tavern_helper', sourceKey: 'opaque-script', ordinal: 0, enabled: true,
  payload: ['opaque-script'], diagnostics: ['script_node_not_object'],
}];

const server = setupServer(
  http.get('/api/settings/generation', () => HttpResponse.json({
    id: '018f0000-0000-7000-8000-000000000001', revision: 1,
    providerId: '018f0000-0000-7000-8000-000000002203', chatPresetId: presetId,
    textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null,
  })),
  http.get('/api/settings/generation/active-resource-context', () => HttpResponse.json({
    globalGenerationConfigRevision: 1,
    mode: 'chat',
    primaryPreset: { id: presetId, revision: 0, name: 'Preset owner', kind: 'chat' },
    conversation: null,
    character: { id: characterId, revision: 1, name: 'Character owner' },
    owners: [
      { kind: 'preset', id: presetId, revision: 0, name: 'Preset owner' },
      { kind: 'character', id: characterId, revision: 1, name: 'Character owner' },
    ],
  })),
  http.get('/api/characters', () => HttpResponse.json([{ id: characterId, revision: 0, name: 'Character owner' }])),
  http.get('/api/presets', () => HttpResponse.json([{ id: presetId, revision: 0, name: 'Preset owner', kind: 'chat' }])),
  http.get('/api/extension-assets', ({ request }) => {
    const url = new URL(request.url);
    const preset = url.searchParams.get('ownerKind') === 'preset';
    return HttpResponse.json({
      owner: { kind: preset ? 'preset' : 'character', id: preset ? presetId : characterId, revision: preset ? 0 : 1, name: preset ? 'Preset owner' : 'Character owner' },
      assets: preset ? presetAssets : opaqueAssets,
    });
  }),
  http.put('/api/extension-assets', async ({ request }) => {
    putCalls += 1;
    const preset = new URL(request.url).searchParams.get('ownerKind') === 'preset';
    const body = await request.json() as { ownerRevision: number; assets: EditableExtensionAssetView[] };
    if (conflictOnce) {
      conflictOnce = false;
      return HttpResponse.json({ error: 'conflict', ownerRevision: 2 }, { status: 409 });
    }
    expect(body.ownerRevision).toBe(preset ? 2 : 1);
    savedAssets = body.assets;
    return HttpResponse.json({
      owner: {
        kind: preset ? 'preset' : 'character', id: preset ? presetId : characterId,
        revision: body.ownerRevision + 1, name: preset ? 'Preset owner' : 'Character owner',
      },
      assets: body.assets,
    });
  }),
  http.get('/api/runtime-states/:scope/:scopeId', ({ params }) => HttpResponse.json({
    scope: params.scope, scopeId: params.scopeId, revision: runtimeRevision, value: runtimeValue,
  })),
  http.post('/api/runtime-states/:scope/:scopeId', async ({ request, params }) => {
    const body = await request.json() as { expectedRevision: number; operation: string; value: Record<string, unknown> };
    expect(body.expectedRevision).toBe(runtimeRevision);
    expect(body.operation).toBe('replace');
    runtimeRevision += 1; runtimeValue = body.value;
    return HttpResponse.json({ scope: params.scope, scopeId: params.scopeId, revision: runtimeRevision, value: runtimeValue });
  }),
  http.get('/api/extension-trust/:kind/:id', ({ params }) => HttpResponse.json({
    owner: { kind: params.kind, id: params.id }, scripts: [], remotes: [],
    bundleDigest: 'b'.repeat(64), trusted: false, sameOriginRisk: true,
    dynamicNetworkDisclaimer: 'Trusted scripts may dynamically contact other origins.', auditEvents: [],
  })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup(); conflictOnce = true; savedAssets = []; putCalls = 0;
  runtimeValue = { count: 1 }; runtimeRevision = 0; vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('ExtensionResourceManagerPage', () => {
  it('switches owners, edits script fields and folders, and retains its draft across a revision conflict', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);

    await user.click(await screen.findByRole('button', { name: /Existing script.*Preset owner/ }));
    expect(await screen.findByText(/Regex #1 · Preset regex/)).not.toBeNull();
    expect(screen.getByText(/Script #1 · Existing script/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add script' }));
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    await user.click(screen.getByRole('button', { name: 'Add nested script' }));
    expect(screen.getAllByLabelText('Script buttons JSON')).toHaveLength(3);
    expect(screen.getAllByLabelText('Script data JSON')).toHaveLength(3);
    expect(screen.getAllByLabelText('Export options JSON')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Add nested folder' })).not.toBeNull();

    const codes = screen.getAllByLabelText('Script code');
    await user.type(codes.at(-1)!, 'draftCode();');
    const notes = screen.getAllByLabelText('Script notes');
    await user.type(notes.at(-1)!, 'draft notes');
    await user.click(screen.getByRole('button', { name: 'Save resources' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Server revision 2');
    expect((codes.at(-1)! as HTMLTextAreaElement).value).toBe('draftCode();');
    await user.click(screen.getByRole('button', { name: 'Retry with server revision' }));
    await waitFor(() => expect(savedAssets).toHaveLength(4));
    const folder = savedAssets.find((asset) => (asset.payload as { type?: string }).type === 'folder');
    expect((folder?.payload as { children?: unknown[] }).children).toEqual([
      expect.objectContaining({ type: 'script', content: 'draftCode();', info: 'draft notes' }),
    ]);

    await user.click(screen.getByRole('button', { name: /opaque-script.*Character owner/ }));
    expect(await screen.findByRole('heading', { name: 'Character owner' })).not.toBeNull();
  });

  it('clears a conflict when switching owners so stale retry cannot overwrite the new owner', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);
    await user.click(await screen.findByRole('button', { name: /Existing script.*Preset owner/ }));
    await screen.findByText(/Script #1 · Existing script/);
    await user.click(screen.getByRole('button', { name: 'Save resources' }));
    expect(await screen.findByRole('button', { name: 'Retry with server revision' })).not.toBeNull();
    expect(putCalls).toBe(1);

    await user.click(screen.getByRole('button', { name: /opaque-script.*Character owner/ }));
    expect(screen.queryByRole('button', { name: 'Retry with server revision' })).toBeNull();
    expect(putCalls).toBe(1);
  });

  it('toggles opaque resources without replacing scalar or array payloads', async () => {
    conflictOnce = false;
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);
    await user.click(await screen.findByRole('button', { name: /opaque-script.*Character owner/ }));
    expect(await screen.findByLabelText('Opaque node JSON')).not.toBeNull();
    expect(screen.getByLabelText('Regex payload JSON')).not.toBeNull();
    const enabled = screen.getAllByLabelText('Enabled');
    await user.click(enabled[0]!);
    await user.click(enabled[1]!);
    await user.click(screen.getByRole('button', { name: 'Save resources' }));

    await waitFor(() => expect(savedAssets).toHaveLength(2));
    expect(savedAssets.map((asset) => asset.enabled)).toEqual([true, false]);
    expect(savedAssets.map((asset) => asset.payload)).toEqual(['opaque-regex', ['opaque-script']]);
  });

  it('validates, copies, saves, and resets scoped variable JSON', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderWithApp(<ExtensionResourceManagerPage />);

    await user.click(screen.getByRole('button', { name: 'Load variables' }));
    const editor = await screen.findByLabelText('Variables JSON');
    expect((editor as HTMLTextAreaElement).value).toContain('"count": 1');
    await user.click(screen.getByRole('button', { name: 'Copy variables' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"count": 1'));

    fireEvent.change(editor, { target: { value: '[]' } });
    expect((screen.getByRole('button', { name: 'Save variables' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('invalid_json');
    fireEvent.change(editor, { target: { value: '{"edited":true}' } });
    await user.click(screen.getByRole('button', { name: 'Save variables' }));
    await waitFor(() => expect(runtimeValue).toEqual({ edited: true }));
    await user.click(screen.getByRole('button', { name: 'Reset variables' }));
    await waitFor(() => expect(runtimeValue).toEqual({}));
  });

  it('requires loading after a Scope ID change and clears the previous owner JSON', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);
    await user.selectOptions(screen.getByLabelText('Runtime State scope'), 'character');
    const scopeId = screen.getByLabelText('Scope ID');
    await user.type(scopeId, characterId);
    await user.click(screen.getByRole('button', { name: 'Load variables' }));
    const editor = await screen.findByLabelText('Variables JSON');
    expect((editor as HTMLTextAreaElement).value).toContain('"count": 1');

    fireEvent.change(scopeId, { target: { value: '018f0000-0000-7000-8000-000000009999' } });
    expect((editor as HTMLTextAreaElement).value).toBe('{}');
    expect((screen.getByRole('button', { name: 'Save variables' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reset variables' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
