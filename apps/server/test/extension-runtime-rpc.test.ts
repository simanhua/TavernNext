import { afterEach, describe, expect, it } from 'vitest';
import {
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  requestPreview,
  requestGeneration,
  seedFullPromptGraph,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

describe('trusted TavernHelper runtime RPC', () => {
  it('persists a canonical message edit and script variables across later reads', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    repositories.extensionAssets.create({
      id: '018f1000-0000-7000-8000-000000000301', ownerKind: 'preset', ownerId: integrationIds.chatPreset,
      kind: 'tavern_helper', sourceKey: 'synthetic-script', ordinal: 0, enabled: true,
      payload: {
        id: 'synthetic-script', type: 'script', name: 'Synthetic', enabled: true,
        content: '', button: { enabled: true, buttons: [] }, data: {},
      },
    });
    const review = (await app.inject({
      method: 'POST', url: `/api/extension-trust/preset/${integrationIds.chatPreset}/grant`,
    })).json();
    const call = (method: string, args: unknown[] = [], patch: Record<string, unknown> = {}) => app.inject({
      method: 'POST',
      url: `/api/conversations/${integrationIds.conversation}/extension-runtime/rpc`,
      payload: {
        ownerKind: 'preset', ownerId: integrationIds.chatPreset, ownerRevision: 0,
        bundleDigest: review.bundleDigest, scriptId: 'synthetic-script', method, args, ...patch,
      },
    });

    const before = await call('getChatMessages');
    expect(before.statusCode).toBe(200);
    expect(before.json().value).toEqual(expect.arrayContaining([
      expect.objectContaining({ message_id: 1, role: 'assistant', message: 'Earlier answer', active_variant_id: integrationIds.historyVariant }),
    ]));

    const edited = await call('setChatMessages', [[{
      message_id: 1, message: 'Changed by trusted script', expected_revision: 1, expected_variant_revision: 0,
    }]]);
    expect(edited.statusCode).toBe(200);
    expect(repositories.messageVariants.get(integrationIds.historyVariant)?.content).toBe('Changed by trusted script');
    expect(repositories.messages.get(integrationIds.historyAssistant)?.content).toBe('Changed by trusted script');

    const variables = await call('replaceVariables', [{ count: 2 }, 'script', null, null]);
    expect(variables.statusCode).toBe(200);
    expect(variables.json().value.value).toEqual({ count: 2 });
    expect((await call('getVariables', ['script'])).json().value.value).toEqual({ count: 2 });

    expect(Object.keys((await call('getAllVariables')).json().value)).toEqual([
      'global', 'character', 'preset', 'conversation', 'messageVariant', 'script',
    ]);
    expect((await call('substitudeMacros', ['{{char}} greets {{user}} with {{model}}'])).json().value)
      .toBe('Aster greets Traveler with mock-model');
    expect((await call('getMessageId', [], { currentMessageId: 0 })).json().value).toBe(0);
    expect((await call('getLastMessageId')).json().value).toBe(1);
    expect((await call('getWorldbookNames')).json().value).toEqual(expect.arrayContaining(['Global lore', 'Character lore']));
    expect((await call('getWorldbook', [integrationIds.globalBook])).json().value).toMatchObject({
      id: integrationIds.globalBook,
      entries: [expect.objectContaining({ id: integrationIds.globalEntry, content: 'GLOBAL-LORE' })],
    });
    expect((await call('updateLorebookEntriesWith', [integrationIds.globalBook, [{
      id: integrationIds.globalEntry, revision: 0, patch: { content: 'GLOBAL-LORE-EDITED' },
    }]])).statusCode).toBe(200);
    expect(repositories.worldbookEntries.get(integrationIds.globalEntry)?.content).toBe('GLOBAL-LORE-EDITED');

    expect((await call('injectPrompts', ['state-hook', { content: 'INJECTED', position: 'before' }])).statusCode).toBe(200);
    expect((await call('getVariables', ['script'])).json().value.value).toMatchObject({
      count: 2,
      promptInjections: { 'state-hook': { content: 'INJECTED', position: 'before' } },
    });
    const injectedPreview = (await requestPreview(app)).json();
    expect(JSON.stringify(injectedPreview.compiledRequest)).toContain('INJECTED');
    expect((await app.inject({
      method: 'DELETE', url: `/api/extension-trust/preset/${integrationIds.chatPreset}`,
    })).statusCode).toBe(200);
    const staleTrustSnapshot = await requestGeneration(app, injectedPreview.snapshotId);
    expect(staleTrustSnapshot.statusCode).toBe(409);
    expect(staleTrustSnapshot.json()).toEqual({ error: 'snapshot_stale' });
    expect((await app.inject({
      method: 'POST', url: `/api/extension-trust/preset/${integrationIds.chatPreset}/grant`,
    })).statusCode).toBe(200);
    const reinjectedPreview = (await requestPreview(app)).json();
    expect((await call('uninjectPrompts', ['state-hook'])).statusCode).toBe(200);
    const staleInjectionSnapshot = await requestGeneration(app, reinjectedPreview.snapshotId);
    expect(staleInjectionSnapshot.statusCode).toBe(409);
    expect(staleInjectionSnapshot.json()).toEqual({ error: 'snapshot_stale' });
    expect(JSON.stringify((await requestPreview(app)).json().compiledRequest)).not.toContain('INJECTED');
    expect((await call('injectPrompts', ['invalid-hook', { position: 'before' }])).statusCode).toBe(400);

    expect((await call('createChatMessages', [[
      { role: 'user', message: 'Created user' },
      { role: 'assistant', message: 'Created assistant' },
    ]])).statusCode).toBe(200);
    expect((await call('getLastMessageId')).json().value).toBe(3);
    expect((await call('deleteChatMessages', [[2, 3]])).statusCode).toBe(200);
    expect((await call('getLastMessageId')).json().value).toBe(1);

    const unsupported = await call('installExtension');
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toEqual({ error: 'not_supported' });
    expect((await call('getTavernRegexes')).json().value).toEqual([]);
    const replacedRegex = await call('replaceTavernRegexes', [[{
      id: 'rpc-regex', scriptName: 'RPC regex', findRegex: '/raw/g', replaceString: 'projected',
      trimStrings: [], placement: [2], disabled: true, markdownOnly: false, promptOnly: false,
      runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null,
    }], 'preset', 0]);
    expect(replacedRegex.statusCode).toBe(200);
    expect(replacedRegex.json().value.ownerRevision).toBe(1);
    expect(repositories.extensionAssets.listByOwner('preset', integrationIds.chatPreset))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'regex', sourceKey: 'rpc-regex' })]));
    expect((await call('getChatMessages')).statusCode).toBe(409);
    expect((await call('getTavernRegexes', [], { ownerRevision: 1 })).json().value)
      .toEqual([expect.objectContaining({ id: 'rpc-regex', disabled: true })]);
    expect((await call('injectPrompts', ['digest-hook', { content: 'DIGEST-INJECTION' }], { ownerRevision: 1 })).statusCode).toBe(200);
    expect(JSON.stringify((await requestPreview(app)).json().compiledRequest)).toContain('DIGEST-INJECTION');
    const scriptAsset = repositories.extensionAssets.listByOwner('preset', integrationIds.chatPreset)
      .find((asset) => asset.kind === 'tavern_helper')!;
    expect(repositories.extensionAssets.update(scriptAsset.id, scriptAsset.revision, {
      payload: { ...(scriptAsset.payload as Record<string, unknown>), content: 'executable changed' },
    })).toMatchObject({ ok: true });
    expect(JSON.stringify((await requestPreview(app)).json().compiledRequest)).not.toContain('DIGEST-INJECTION');
    expect(JSON.stringify([before.json(), edited.json(), variables.json()])).not.toContain('TOP-SECRET');
  });

  it('rejects stale or inactive runtime identities with stable errors', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');

    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/extension-runtime/rpc`,
      payload: {
        ownerKind: 'preset', ownerId: integrationIds.chatPreset, ownerRevision: 99,
        bundleDigest: '0'.repeat(64), scriptId: 'missing', method: 'getChatMessages', args: [],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'stale_runtime' });
  });
});
