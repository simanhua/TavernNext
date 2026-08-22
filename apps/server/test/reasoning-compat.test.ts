import { afterEach, describe, expect, it } from 'vitest';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  requestGeneration,
  seedFullPromptGraph,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

describe('target Preset reasoning compatibility', () => {
  it('extracts a completed think block into persisted reasoning only after the Preset is trusted', async () => {
    let streamEntered!: () => void;
    let releaseStream!: () => void;
    const entered = new Promise<void>((resolve) => { streamEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseStream = resolve; });
    const provider = capturedProvider();
    provider.client.streamChat = async function* (request) {
      provider.chat.push(structuredClone(request));
      yield { type: 'delta', text: '<think>命定推演\nHidden chain</think><gametxt>Visible answer</gametxt>' };
      streamEntered();
      await release;
      yield { type: 'completed', finishReason: 'stop' };
    };
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    repositories.extensionAssets.create({
      id: crypto.randomUUID(), ownerKind: 'preset', ownerId: integrationIds.chatPreset,
      kind: 'tavern_helper', sourceKey: 'reasoning', ordinal: 0, enabled: true,
      payload: {
        type: 'script', id: 'reasoning', name: '【命定之诗】思维链', enabled: true,
        content: 'ReasoningRegexStyler', button: {},
      },
    });
    expect((await app.inject({
      method: 'POST', url: `/api/extension-trust/preset/${integrationIds.chatPreset}/grant`,
    })).statusCode).toBe(200);

    const generating = requestGeneration(app);
    await entered;
    expect((await app.inject({
      method: 'DELETE', url: `/api/extension-trust/preset/${integrationIds.chatPreset}`,
    })).statusCode).toBe(200);
    releaseStream();
    expect((await generating).statusCode).toBe(200);
    const detail = (await app.inject({
      method: 'GET', url: `/api/conversations/${integrationIds.conversation}/messages`,
    })).json();
    const assistant = [...detail.messages].reverse().find((message: { role: string }) => message.role === 'assistant');
    const active = assistant.variants.find((variant: { id: string }) => variant.id === assistant.activeVariantId);
    expect(active).toMatchObject({
      reasoning: '命定推演\nHidden chain', content: '<gametxt>Visible answer</gametxt>', status: 'completed',
    });
  });
});
