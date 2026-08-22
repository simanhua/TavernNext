// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EditableExtensionAssetView } from '../../api/client.js';
import { renderWithApp } from '../../test/render.js';
import { useChatUi } from '../chat/chat-store.js';
import { ExtensionResourceManagerPage } from './ExtensionResourceManagerPage.js';

const firstPresetId = '018f0000-0000-7000-8000-000000002601';
const secondPresetId = '018f0000-0000-7000-8000-000000002602';
const firstCharacterId = '018f0000-0000-7000-8000-000000002603';
const secondCharacterId = '018f0000-0000-7000-8000-000000002604';
let savedOwner: { kind: string; id: string } | undefined;
let savedAssets: EditableExtensionAssetView[] = [];

function owner(kind: 'character' | 'preset', id: string) {
  const names: Record<string, string> = {
    [firstPresetId]: 'First preset', [secondPresetId]: 'Second preset',
    [firstCharacterId]: 'First character', [secondCharacterId]: 'Second character',
  };
  return { kind, id, revision: 0, name: names[id]! };
}

const server = setupServer(
  http.get('/api/settings/generation', () => HttpResponse.json({
    id: '018f0000-0000-7000-8000-000000000001', revision: 1,
    providerId: '018f0000-0000-7000-8000-000000002605', chatPresetId: firstPresetId,
    textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null,
  })),
  http.get('/api/settings/generation/active-resource-context', () => HttpResponse.json({
    globalGenerationConfigRevision: 1, mode: 'chat',
    primaryPreset: { id: firstPresetId, revision: 0, name: 'First preset', kind: 'chat' },
    conversation: { id: '018f0000-0000-7000-8000-000000002606', revision: 0 },
    character: { id: firstCharacterId, revision: 0, name: 'First character' },
    owners: [owner('preset', firstPresetId), owner('character', firstCharacterId)],
  })),
  http.get('/api/characters', () => HttpResponse.json([
    { id: firstCharacterId, revision: 0, name: 'First character' },
    { id: secondCharacterId, revision: 0, name: 'Second character' },
  ])),
  http.get('/api/presets', () => HttpResponse.json([
    { id: firstPresetId, revision: 0, name: 'First preset', kind: 'chat' },
    { id: secondPresetId, revision: 0, name: 'Second preset', kind: 'chat' },
  ])),
  http.get('/api/extension-assets', ({ request }) => {
    const url = new URL(request.url);
    const kind = url.searchParams.get('ownerKind') as 'character' | 'preset';
    const id = url.searchParams.get('ownerId')!;
    const currentOwner = owner(kind, id);
    const assets: EditableExtensionAssetView[] = kind === 'character' ? [{
      kind: 'tavern_helper', sourceKey: `${id}-script`, ordinal: 0, enabled: true, diagnostics: [],
      payload: { id: `${id}-script`, type: 'script', name: `${currentOwner.name} script`, enabled: true, content: '', opaque: id },
    }] : [{
      kind: 'regex', sourceKey: `${id}-regex`, ordinal: 0, enabled: true, diagnostics: [],
      payload: { id: `${id}-regex`, scriptName: `${currentOwner.name} regex`, placement: [2], opaque: id },
    }];
    return HttpResponse.json({ owner: currentOwner, assets });
  }),
  http.put('/api/extension-assets', async ({ request }) => {
    const url = new URL(request.url);
    const body = await request.json() as { assets: EditableExtensionAssetView[] };
    savedOwner = { kind: url.searchParams.get('ownerKind')!, id: url.searchParams.get('ownerId')! };
    savedAssets = body.assets;
    return HttpResponse.json({ owner: { ...owner(savedOwner.kind as 'character', savedOwner.id), revision: 1 }, assets: body.assets });
  }),
  http.get('/api/extension-trust/:kind/:id', ({ params }) => HttpResponse.json({
    owner: { kind: params.kind, id: params.id }, scripts: [], remotes: [], bundleDigest: 'b'.repeat(64),
    trusted: false, sameOriginRisk: true, dynamicNetworkDisclaimer: 'risk', auditEvents: [],
  })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  savedOwner = undefined;
  savedAssets = [];
  useChatUi.setState({ activeConversationId: null, draft: '' });
});
afterAll(() => server.close());

describe('Attached Resources All Resources', () => {
  it('composes name and source filters and saves an inactive owner without activating it', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);

    expect(await screen.findByRole('tab', { name: 'Scripts 1' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Second character script/ })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'All Resources' }));
    expect(await screen.findByRole('tab', { name: 'Scripts 2' })).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Regexes 2' })).not.toBeNull();

    await user.type(screen.getByLabelText('Search resources'), 'Second');
    await user.selectOptions(screen.getByLabelText('Source kind'), 'character');
    expect(screen.getByRole('tab', { name: 'Scripts 1' })).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Regexes 0' })).not.toBeNull();
    const inactiveScript = screen.getByRole('button', { name: /Second character script.*Inactive source.*Enabled.*Untrusted/ });
    await user.click(inactiveScript);
    await user.click(screen.getByLabelText('Enabled'));
    await user.click(screen.getByRole('button', { name: 'Save resources' }));
    await waitFor(() => expect(savedOwner).toEqual({ kind: 'character', id: secondCharacterId }));
    expect(savedAssets).toEqual([expect.objectContaining({ enabled: false, payload: expect.objectContaining({ opaque: secondCharacterId }) })]);

    await user.click(screen.getByRole('tab', { name: 'Regexes 0' }));
    expect(screen.getByText('No resources match the current filters.')).not.toBeNull();
    await user.selectOptions(screen.getByLabelText('Source kind'), 'preset');
    expect(screen.getByRole('tab', { name: 'Regexes 1' })).not.toBeNull();
    expect(screen.getByRole('button', { name: /Second preset regex.*Inactive source.*Enabled/ })).not.toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Current Context' }));
    expect(screen.queryByLabelText('Search resources')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Scripts 1' })).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Regexes 1' })).not.toBeNull();
  });
});
