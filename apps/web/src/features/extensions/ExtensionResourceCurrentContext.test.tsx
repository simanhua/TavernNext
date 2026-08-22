// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { useChatUi } from '../chat/chat-store.js';
import { ExtensionResourceManagerPage } from './ExtensionResourceManagerPage.js';

const presetId = '018f0000-0000-7000-8000-000000002501';
const firstCharacterId = '018f0000-0000-7000-8000-000000002502';
const secondCharacterId = '018f0000-0000-7000-8000-000000002503';
const firstConversationId = '018f0000-0000-7000-8000-000000002504';
const secondConversationId = '018f0000-0000-7000-8000-000000002505';
let trusted = false;

const server = setupServer(
  http.get('/api/settings/generation', () => HttpResponse.json({
    id: '018f0000-0000-7000-8000-000000000001', revision: 1,
    providerId: '018f0000-0000-7000-8000-000000002506', chatPresetId: presetId,
    textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null,
  })),
  http.get('/api/settings/generation/active-resource-context', ({ request }) => {
    const conversationId = new URL(request.url).searchParams.get('conversationId');
    const characterId = conversationId === secondConversationId ? secondCharacterId : firstCharacterId;
    const characterName = conversationId === secondConversationId ? 'Second character' : 'First character';
    return HttpResponse.json({
      globalGenerationConfigRevision: 1,
      mode: 'chat',
      primaryPreset: { id: presetId, revision: 0, name: 'Primary preset', kind: 'chat' },
      conversation: { id: conversationId, revision: 0 },
      character: { id: characterId, revision: 0, name: characterName },
      owners: [
        { kind: 'preset', id: presetId, revision: 0, name: 'Primary preset' },
        { kind: 'character', id: characterId, revision: 0, name: characterName },
      ],
    });
  }),
  http.get('/api/extension-assets', ({ request }) => {
    const url = new URL(request.url);
    const kind = url.searchParams.get('ownerKind') as 'character' | 'preset';
    const id = url.searchParams.get('ownerId')!;
    const name = id === presetId ? 'Primary preset' : id === secondCharacterId ? 'Second character' : 'First character';
    return HttpResponse.json({
      owner: { kind, id, revision: 0, name },
      assets: id === presetId ? [{
        kind: 'regex', sourceKey: 'preset-regex', ordinal: 0, enabled: false, diagnostics: [],
        payload: { id: 'preset-regex', scriptName: 'Preset regex', placement: [2], promptOnly: true },
      }] : [{
        kind: 'tavern_helper', sourceKey: `${id}-script`, ordinal: 0, enabled: true, diagnostics: [],
        payload: { id: `${id}-script`, type: 'script', name: `${name} script`, enabled: false, content: '' },
      }],
    });
  }),
  http.get('/api/extension-trust/:kind/:id', ({ params }) => HttpResponse.json({
    owner: { kind: params.kind, id: params.id }, scripts: [], remotes: [], bundleDigest: 'b'.repeat(64),
    trusted, sameOriginRisk: true, dynamicNetworkDisclaimer: 'risk', auditEvents: [],
  })),
  http.post('/api/extension-trust/:kind/:id/grant', ({ params }) => {
    trusted = true;
    return HttpResponse.json({
      owner: { kind: params.kind, id: params.id }, scripts: [], remotes: [], bundleDigest: 'b'.repeat(64),
      trusted, sameOriginRisk: true, dynamicNetworkDisclaimer: 'risk', auditEvents: [],
    });
  }),
  http.delete('/api/extension-trust/:kind/:id', ({ params }) => {
    trusted = false;
    return HttpResponse.json({
      owner: { kind: params.kind, id: params.id }, scripts: [], remotes: [], bundleDigest: 'b'.repeat(64),
      trusted, sameOriginRisk: true, dynamicNetworkDisclaimer: 'risk', auditEvents: [],
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  trusted = false;
  useChatUi.setState({ activeConversationId: null, draft: '' });
});
afterAll(() => server.close());

describe('Attached Resources Current Context', () => {
  it('follows the active Conversation Character while retaining the primary Preset', async () => {
    useChatUi.setState({ activeConversationId: firstConversationId });
    const user = userEvent.setup();
    renderWithApp(<ExtensionResourceManagerPage />);

    expect(await screen.findByRole('tab', { name: 'Scripts 1' })).not.toBeNull();
    expect(screen.getByRole('button', { name: /First character script.*Disabled.*Untrusted/ })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /First character script/ }));
    await user.click(await screen.findByRole('button', { name: 'Grant trust' }));
    expect(await screen.findByRole('button', { name: /First character script.*Disabled.*Trusted/ })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revoke trust' }));
    expect(await screen.findByRole('button', { name: /First character script.*Disabled.*Untrusted/ })).not.toBeNull();

    useChatUi.getState().setActiveConversationId(secondConversationId);
    expect(await screen.findByRole('button', { name: /Second character script.*Disabled.*Untrusted/ })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /First character script/ })).toBeNull();
    expect(screen.getByText('The selected resource left the current context.')).not.toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Regexes 1' }));
    expect(screen.getByRole('button', { name: /Preset regex.*Primary preset.*Disabled/ })).not.toBeNull();
  });

  it('shows explicit missing Preset and Character context states', async () => {
    server.use(http.get('/api/settings/generation/active-resource-context', () => HttpResponse.json({
      globalGenerationConfigRevision: 1, mode: 'chat', primaryPreset: null, conversation: null, character: null, owners: [],
    })));
    renderWithApp(<ExtensionResourceManagerPage />);

    expect(await screen.findByText('No primary Preset is configured for the active Provider mode.')).not.toBeNull();
    expect(screen.getByText('No active Conversation Character is selected.')).not.toBeNull();
  });
});
