import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildTrustedScriptManifest } from '@tavernnext/extension-runtime';
import {
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  seedFullPromptGraph,
} from '../../apps/server/test/prompt-integration-fixtures.js';
import {
  SameOriginScriptRuntimeFrame,
  type RuntimeApiCaller,
} from '../../apps/web/src/features/extensions/SameOriginScriptRuntime.js';

afterEach(async () => {
  await closePromptIntegrationContexts();
});

describe('trusted synthetic script full-stack persistence', () => {
  it('updates server messages and variables through the bridge and observes them after runtime reload', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    repositories.extensionAssets.create({
      id: '018f1000-0000-7000-8000-000000000401', ownerKind: 'preset', ownerId: integrationIds.chatPreset,
      kind: 'tavern_helper', sourceKey: 'full-stack-script', ordinal: 0, enabled: true,
      payload: { id: 'full-stack-script', type: 'script', name: 'Full stack', enabled: true, content: '', button: {} },
    });
    const trust = (await app.inject({
      method: 'POST', url: `/api/extension-trust/preset/${integrationIds.chatPreset}/grant`,
    })).json() as { bundleDigest: string };
    const owner = repositories.presets.get(integrationIds.chatPreset)!;
    const runtimeManifest = (content: string) => buildTrustedScriptManifest(integrationIds.conversation, {
      preset: {
        owner: { kind: 'preset', id: owner.id }, revision: owner.revision,
        bundleDigest: trust.bundleDigest, trusted: true,
        assets: [{
          kind: 'tavern_helper', sourceKey: 'full-stack-script', ordinal: 0, enabled: true,
          payload: { id: 'full-stack-script', type: 'script', name: 'Full stack', enabled: true, content, button: {} },
        }],
      },
    });
    const caller: RuntimeApiCaller = async (input) => {
      const { conversationId, ...payload } = input;
      const response = await app.inject({
        method: 'POST', url: `/api/conversations/${conversationId}/extension-runtime/rpc`, payload,
      });
      const body = response.json() as { value?: unknown; error?: string };
      if (response.statusCode >= 400) throw Object.assign(new Error(body.error), { code: body.error });
      return body.value;
    };
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    const document = dom.window.document;
    const mount = document.createElement('div');
    document.body.append(mount);
    const first = new SameOriginScriptRuntimeFrame(document, mount, () => undefined, caller);
    await first.start(runtimeManifest(`
      eventOn(event_types.APP_READY, async () => {
        await setChatMessages([{ message_id: 1, message: 'Persisted by script', expected_revision: 1, expected_variant_revision: 0 }]);
        await replaceVariables({ persisted: true });
      });
    `));
    first.destroy();

    const second = new SameOriginScriptRuntimeFrame(document, mount, () => undefined, caller);
    await second.start(runtimeManifest(`
      eventOn(event_types.APP_READY, async () => {
        parent.fullStackReload = { messages: await getChatMessages(), variables: await getVariables() };
      });
    `));

    expect((dom.window as unknown as { fullStackReload?: { messages: Array<{ message: string }>; variables: { value: unknown } } }).fullStackReload)
      .toMatchObject({
        messages: expect.arrayContaining([expect.objectContaining({ message: 'Persisted by script' })]),
        variables: { value: { persisted: true } },
      });
    dom.window.close();
  });
});
