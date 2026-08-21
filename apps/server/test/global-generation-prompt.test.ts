import { afterEach, describe, expect, it } from 'vitest';
import {
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  seedFullPromptGraph,
  unitTokenizerRuntime,
} from './prompt-integration-fixtures.js';
import type { Repositories } from '../src/db/repositories.js';

afterEach(closePromptIntegrationContexts);

async function createUnconfiguredConversation(
  app: Awaited<ReturnType<typeof createPromptIntegrationContext>>['app'],
  id: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: {
      id,
      characterId: integrationIds.character,
      personaId: integrationIds.persona,
      title: 'Global configuration chat',
      maxPromptTokens: 4_000,
      maxResponseTokens: 128,
    },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).not.toHaveProperty('providerId');
  expect(response.json()).not.toHaveProperty('presetId');
  return response.json() as { id: string; revision: number };
}

describe('global generation configuration prompt binding', () => {
  it('reports a stable configuration error when a new Conversation has no global or legacy Provider', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    const conversation = await createUnconfiguredConversation(
      app,
      '018f1000-0000-7000-8000-000000000204',
    );

    const preview = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: 'Missing configuration' },
    });

    expect(preview.statusCode).toBe(422);
    expect(preview.json()).toEqual({ error: 'provider_not_configured' });
  });

  it('does not fill a missing global Preset from an old Conversation', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    const graph = seedFullPromptGraph(repositories, 'chat');
    expect(repositories.globalGenerationConfig.update(0, { providerId: graph.provider.id }))
      .toMatchObject({ ok: true });

    const preview = await app.inject({
      method: 'POST',
      url: `/api/conversations/${graph.conversation.id}/prompt-preview`,
      payload: { conversationRevision: graph.conversation.revision, mode: 'normal', userText: 'Do not revive legacy' },
    });

    expect(preview.statusCode).toBe(422);
    expect(preview.json()).toEqual({ error: 'preset_not_configured' });
  });

  it.each(['chat', 'text'] as const)('previews a new %s Conversation without per-chat Provider or Preset IDs', async (mode) => {
    const { app, repositories, provider: captured } = await createPromptIntegrationContext();
    const graph = seedFullPromptGraph(repositories, mode);
    if (mode === 'text') {
      expect(repositories.presets.update(graph.contextPreset.id, graph.contextPreset.revision, {
        settings: {
          ...graph.contextPreset.settings,
          story_string: '{{system}}\n{{description}}\n{{wiBefore}}\n{{wiAfter}}',
        },
      })).toMatchObject({ ok: true });
    }
    const configured = repositories.globalGenerationConfig.update(0, {
      providerId: graph.provider.id,
      chatPresetId: graph.chatPreset.id,
      textPresetId: graph.textPreset.id,
      contextPresetId: graph.contextPreset.id,
      instructPresetId: graph.instructPreset.id,
      systemPresetId: graph.systemPreset.id,
    });
    expect(configured).toMatchObject({ ok: true, value: { revision: 1 } });
    const conversation = await createUnconfiguredConversation(
      app,
      mode === 'chat'
        ? '018f1000-0000-7000-8000-000000000201'
        : '018f1000-0000-7000-8000-000000000202',
    );

    const preview = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: 'Use global configuration' },
    });

    expect(preview.statusCode).toBe(201);
    expect(preview.json()).toMatchObject({
      kind: mode,
      entityRevisions: {
        globalGenerationConfig: { revision: 1 },
        provider: { id: graph.provider.id },
      },
    });
    if (mode === 'chat') expect(preview.json().messages).toEqual(expect.any(Array));
    else {
      expect(preview.json().text).toContain('<CHAT>');
      expect(preview.json().text).toContain('<U>');
      expect(preview.json().text).toContain('SYSTEM Aster');
      expect(preview.json().stop).toEqual(expect.arrayContaining([expect.stringContaining('<STOP>')]));
    }

    const generation = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/generations`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: 'Generate globally' },
    });
    expect(generation.statusCode).toBe(200);
    expect(mode === 'chat' ? captured.chat : captured.text).toHaveLength(1);
  });

  it('rejects a candidate when global configuration changes during preparation', async () => {
    let repositories: Repositories | undefined;
    let advanced = false;
    const tokenizer = unitTokenizerRuntime({
      async countMessages(messages, decision) {
        if (!advanced) {
          advanced = true;
          const current = repositories!.globalGenerationConfig.get();
          expect(repositories!.globalGenerationConfig.update(current.revision, {
            chatPresetId: current.chatPresetId,
          })).toMatchObject({ ok: true });
        }
        return messages.reduce((total, message) => total + message.content.length + 1, 0);
      },
    });
    const context = await createPromptIntegrationContext({ tokenizerRuntime: tokenizer });
    repositories = context.repositories;
    const graph = seedFullPromptGraph(repositories, 'chat');
    expect(repositories.globalGenerationConfig.update(0, {
      providerId: graph.provider.id,
      chatPresetId: graph.chatPreset.id,
    })).toMatchObject({ ok: true });
    const conversation = await createUnconfiguredConversation(
      context.app,
      '018f1000-0000-7000-8000-000000000203',
    );

    const preview = await context.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/prompt-preview`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: 'Race the configuration' },
    });

    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toEqual({ error: 'snapshot_stale' });
  });
});
