// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import type { EditableExtensionAssetView } from '../../api/client.js';
import { ExtensionResourceManagerPage } from './ExtensionResourceManagerPage.js';

const characterId = '018f0000-0000-7000-8000-000000002201';
const presetId = '018f0000-0000-7000-8000-000000002202';
let conflictOnce = true;
let savedAssets: EditableExtensionAssetView[] = [];
let putCalls = 0;

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
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); conflictOnce = true; savedAssets = []; putCalls = 0; });
afterAll(() => server.close());

describe('ExtensionResourceManagerPage', () => {
  it('switches owners, edits script fields and folders, and retains its draft across a revision conflict', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);

    await user.selectOptions(await screen.findByLabelText('Owner type'), 'preset');
    await user.selectOptions(await screen.findByLabelText('Resource owner'), presetId);
    await user.click(screen.getByRole('button', { name: 'Load resources' }));
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

    await user.selectOptions(screen.getByLabelText('Owner type'), 'character');
    await user.selectOptions(screen.getByLabelText('Resource owner'), characterId);
    await user.click(screen.getByRole('button', { name: 'Load resources' }));
    expect(await screen.findByRole('heading', { name: 'Character owner' })).not.toBeNull();
  });

  it('clears a conflict when switching owners so stale retry cannot overwrite the new owner', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);
    await user.selectOptions(await screen.findByLabelText('Owner type'), 'preset');
    await user.selectOptions(screen.getByLabelText('Resource owner'), presetId);
    await user.click(screen.getByRole('button', { name: 'Load resources' }));
    await screen.findByText(/Script #1 · Existing script/);
    await user.click(screen.getByRole('button', { name: 'Save resources' }));
    expect(await screen.findByRole('button', { name: 'Retry with server revision' })).not.toBeNull();
    expect(putCalls).toBe(1);

    await user.selectOptions(screen.getByLabelText('Owner type'), 'character');
    await user.selectOptions(screen.getByLabelText('Resource owner'), characterId);
    expect(screen.queryByRole('button', { name: 'Retry with server revision' })).toBeNull();
    expect(putCalls).toBe(1);
  });

  it('toggles opaque resources without replacing scalar or array payloads', async () => {
    conflictOnce = false;
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);
    await screen.findByRole('option', { name: 'Character owner' });
    await user.selectOptions(screen.getByLabelText('Resource owner'), characterId);
    await user.click(screen.getByRole('button', { name: 'Load resources' }));
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
});
