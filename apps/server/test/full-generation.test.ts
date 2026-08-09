import { ProviderError } from '@tavernnext/provider-openai-compatible';
import { TokenizerId, selectTokenizer } from '@tavernnext/tokenizer-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createPromptSnapshotService } from '../src/services/prompt-snapshot-service.js';
import type { Repositories } from '../src/db/repositories.js';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  previewPayload,
  requestGeneration,
  requestPreview,
  seedFullPromptGraph,
  unitTokenizerRuntime,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

function parseEventNames(payload: string): string[] {
  return payload.trim().split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const line = frame.split(/\r?\n/).find((candidate) => candidate.startsWith('event: '));
    if (line === undefined) throw new Error(`Malformed SSE frame: ${frame}`);
    return line.slice('event: '.length);
  });
}

function runtimeStates(repositories: Repositories): Array<{ conversationId: string; revision: number; timedState: unknown }> {
  return repositories.worldbookRuntimeStates.list();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('full prompt generation', () => {
  it('sends the exact stored Chat preview request and commits timed state only after success', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: 'The portal opens.' },
      { type: 'usage', inputTokens: 321, outputTokens: 4 },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const previewResponse = await requestPreview(app);
    const preview = previewResponse.json();
    expect(runtimeStates(repositories)).toEqual([]);

    const generation = await requestGeneration(app, preview.snapshotId);

    expect(generation.statusCode).toBe(200);
    expect(parseEventNames(generation.payload)).toEqual(['started', 'delta', 'usage', 'completed']);
    expect(provider.chat).toEqual([preview.compiledRequest]);
    expect(provider.text).toEqual([]);
    expect(runtimeStates(repositories)).toEqual([
      expect.objectContaining({
        conversationId: integrationIds.conversation,
        revision: 0,
        timedState: preview.worldbook.timedState,
      }),
    ]);
    expect(repositories.messages.list().filter((message) => message.conversationId === integrationIds.conversation))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Open the portal' }),
        expect.objectContaining({ role: 'assistant', activeVariantId: expect.any(String) }),
      ]));
    expect(repositories.messageVariants.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'The portal opens.', status: 'completed', finishReason: 'stop' }),
    ]));
    expect(repositories.generationSnapshots.get(preview.snapshotId)?.payload).toEqual(
      repositories.generationSnapshots.list()[0]?.payload,
    );
    expect(JSON.stringify(repositories.generationSnapshots.get(preview.snapshotId)?.payload)).not.toContain('inputTokens');
    expect(JSON.stringify(repositories.generationSnapshots.get(preview.snapshotId)?.payload)).not.toContain('321');
  });

  it('routes Text profiles through streamText with the exact stored prompt, stops, and parameters', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: 'Text answer' },
      { type: 'completed', finishReason: 'length' },
    ]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'text');
    const preview = (await requestPreview(app)).json();

    const generation = await requestGeneration(app, preview.snapshotId);

    expect(generation.statusCode).toBe(200);
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([preview.compiledRequest]);
    expect(provider.text[0]).toMatchObject({
      model: 'mock-model',
      prompt: preview.text,
      stop: preview.stop,
      temperature: 0.4,
      maxTokens: 72,
    });
  });

  it.each(['chat', 'text'] as const)('routes Worldbook positions 0-7 into exact %s compiler targets', async (mode) => {
    const provider = capturedProvider([{ type: 'completed', finishReason: 'stop' }]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, mode);
    const character = repositories.characters.get(integrationIds.character)!;
    expect(repositories.characters.update(character.id, character.revision, {
      examples: '<START>\nTraveler: CARD-EXAMPLE\nAster: CARD-ANSWER',
    })).toMatchObject({ ok: true });
    if (mode === 'chat') {
      const preset = repositories.presets.get(integrationIds.chatPreset)!;
      const prompts = preset.settings.prompts as Array<Record<string, unknown>>;
      const promptOrder = preset.settings.prompt_order as Array<{ character_id: string; order: Array<Record<string, unknown>> }>;
      expect(repositories.presets.update(preset.id, preset.revision, {
        settings: {
          ...preset.settings,
          prompts: [
            ...prompts.slice(0, -2),
            { identifier: 'dialogueExamples', marker: true, system_prompt: true },
            ...prompts.slice(-2),
          ],
          prompt_order: [{
            ...promptOrder[0],
            order: [
              ...promptOrder[0]!.order.slice(0, -2),
              { identifier: 'dialogueExamples', enabled: true },
              ...promptOrder[0]!.order.slice(-2),
            ],
          }],
        },
      })).toMatchObject({ ok: true });
    }
    const entries = [
      { id: '018f1000-0000-7000-8000-000000000125', sourceUid: 'an-top', position: 2, content: 'AN-TOP' },
      { id: '018f1000-0000-7000-8000-000000000126', sourceUid: 'an-bottom', position: 3, content: 'AN-BOTTOM' },
      { id: '018f1000-0000-7000-8000-000000000127', sourceUid: 'at-depth', position: 4, content: 'AT-DEPTH', depth: 1, role: 1 },
      { id: '018f1000-0000-7000-8000-000000000128', sourceUid: 'em-top', position: 5, content: '<START>\nTraveler: EM-TOP\nAster: EM-TOP-A' },
      { id: '018f1000-0000-7000-8000-000000000129', sourceUid: 'em-bottom', position: 6, content: '<START>\nTraveler: EM-BOTTOM\nAster: EM-BOTTOM-A' },
      { id: '018f1000-0000-7000-8000-000000000130', sourceUid: 'outlet', position: 7, content: 'OUTLET-ONLY', outletName: 'sidebar' },
    ];
    for (const entry of entries) {
      repositories.worldbookEntries.create({
        worldbookId: integrationIds.globalBook,
        sourceOrdinal: Number(entry.position), keys: [], constant: true,
        ...entry,
      });
    }

    const previewResponse = await requestPreview(app);

    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json();
    const executable = mode === 'chat'
      ? JSON.stringify(preview.messages)
      : String(preview.text);
    if (mode === 'chat') {
      expect(preview.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'AN-TOP\nAN-BOTTOM' }),
      ]));
    } else {
      expect(executable).toContain('AN-TOP\nAN-BOTTOM');
    }
    expect(executable).toContain('AT-DEPTH');
    expect(executable.indexOf('EM-TOP')).toBeLessThan(executable.indexOf('CARD-EXAMPLE'));
    expect(executable.indexOf('CARD-EXAMPLE')).toBeLessThan(executable.indexOf('EM-BOTTOM'));
    expect(executable).not.toContain('OUTLET-ONLY');
    expect(preview.worldInfoOutlets).toEqual({ sidebar: 'OUTLET-ONLY' });
    const generation = await requestGeneration(app, preview.snapshotId);
    expect(generation.statusCode).toBe(200);
    expect(mode === 'chat' ? provider.chat : provider.text).toEqual([preview.compiledRequest]);
  });

  it('selects BEST_MATCH for Text through the OpenAI-compatible API/model contract', async () => {
    const selections: Array<{ api?: string; model?: string }> = [];
    const tokenizerRuntime = unitTokenizerRuntime({
      selectTokenizer(input) {
        selections.push({ api: input.api, model: input.model });
        return selectTokenizer(input);
      },
    });
    const { app, repositories } = await createPromptIntegrationContext({ tokenizerRuntime });
    seedFullPromptGraph(repositories, 'text');
    const provider = repositories.providerProfiles.get(integrationIds.provider)!;
    expect(repositories.providerProfiles.update(provider.id, provider.revision, {
      model: 'gpt-3.5-turbo-instruct',
    })).toMatchObject({ ok: true });
    const preset = repositories.presets.get(integrationIds.textPreset)!;
    expect(repositories.presets.update(preset.id, preset.revision, {
      settings: { ...preset.settings, tokenizer: TokenizerId.BEST_MATCH },
    })).toMatchObject({ ok: true });

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(201);
    expect(selections).toEqual([{ api: 'openai', model: 'gpt-3.5-turbo-instruct' }]);
    expect(response.json().tokenizerDecision).toMatchObject({
      tokenizerId: TokenizerId.OPENAI,
      tiktokenModel: 'gpt-3.5-turbo',
    });
  });

  it('scans only typed Character depth_prompt extensions and surfaces persisted compatibility warnings', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    const character = repositories.characters.get(integrationIds.character)!;
    expect(repositories.characters.update(character.id, character.revision, {
      extensions: { depth_prompt: { prompt: 'Typed Character depth prompt' } },
      postHistoryInstructions: 'PHI-only',
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['character_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    const preset = repositories.presets.get(integrationIds.chatPreset)!;
    expect(repositories.presets.update(preset.id, preset.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['preset_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    const book = repositories.worldbooks.get(integrationIds.globalBook)!;
    expect(repositories.worldbooks.update(book.id, book.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['worldbook_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    repositories.worldbookEntries.create({
      id: '018f1000-0000-7000-8000-000000000122', worldbookId: integrationIds.globalBook,
      sourceUid: 'typed-depth', sourceOrdinal: 3, keys: ['Typed Character depth prompt'],
      content: 'TYPED-DEPTH-MATCH', matchCharacterDepthPrompt: true,
    });
    repositories.worldbookEntries.create({
      id: '018f1000-0000-7000-8000-000000000123', worldbookId: integrationIds.globalBook,
      sourceUid: 'phi-depth', sourceOrdinal: 4, keys: ['PHI-only'],
      content: 'PHI-MUST-NOT-MATCH', matchCharacterDepthPrompt: true,
    });

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(201);
    const preview = response.json();
    expect(preview.worldbook.activated.map((entry: { content: string }) => entry.content)).toContain('TYPED-DEPTH-MATCH');
    expect(preview.worldbook.activated.map((entry: { content: string }) => entry.content)).not.toContain('PHI-MUST-NOT-MATCH');
    expect(preview.warnings).toEqual(expect.arrayContaining([
      { code: 'compatibility_warning', message: 'character_compat_warning', source: `character:${integrationIds.character}` },
      { code: 'compatibility_warning', message: 'preset_compat_warning', source: `preset:${integrationIds.chatPreset}` },
      { code: 'compatibility_warning', message: 'worldbook_compat_warning', source: `worldbook:${integrationIds.globalBook}` },
    ]));
  });

  it('loads and revalidates prompt history only through relationship-indexed repositories', async () => {
    const { database, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    repositories.messages.list = () => { throw new Error('global message scan'); };
    repositories.messageVariants.list = () => { throw new Error('global variant scan'); };
    const service = createPromptSnapshotService({
      database,
      repositories,
      tokenizerRuntime: unitTokenizerRuntime(),
    });

    const preview = await service.createPreview({
      conversationId: integrationIds.conversation,
      ...previewPayload(),
      mode: 'normal' as const,
    });

    expect(preview.compiledRequestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed for an activated Worldbook position without an exact compiler target', async () => {
    const provider = capturedProvider();
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    repositories.worldbookEntries.create({
      id: '018f1000-0000-7000-8000-000000000124', worldbookId: integrationIds.globalBook,
      sourceUid: 'future-position', sourceOrdinal: 5, keys: [], constant: true,
      content: 'MUST-NOT-COLLAPSE', position: 99,
    });

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'unsupported_worldbook_placement' });
    expect(provider.chat).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
  });

  it('rejects every changed executable aggregate with zero provider calls and zero partial writes', async () => {
    const provider = capturedProvider();
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const beforeMessages = repositories.messages.list();
    const mutations: Array<[string, () => void]> = [
      ['preset revision', () => {
        const value = repositories.presets.get(integrationIds.chatPreset)!;
        repositories.presets.update(value.id, value.revision, { settings: { ...value.settings, temperature: 0.9 } });
      }],
      ['Worldbook entry revision', () => {
        const value = repositories.worldbookEntries.get(integrationIds.characterEntry)!;
        repositories.worldbookEntries.update(value.id, value.revision, { content: 'EDITED LORE' });
      }],
      ['Worldbook entry collection', () => {
        repositories.worldbookEntries.create({
          id: '018f1000-0000-7000-8000-000000000120',
          worldbookId: integrationIds.conversationBook,
          sourceUid: 'added',
          sourceOrdinal: 2,
          keys: [],
          constant: true,
          content: 'ADDED LORE',
        });
      }],
      ['provider revision', () => {
        const value = repositories.providerProfiles.get(integrationIds.provider)!;
        repositories.providerProfiles.update(value.id, value.revision, { model: 'changed-model' });
      }],
      ['Character revision', () => {
        const value = repositories.characters.get(integrationIds.character)!;
        repositories.characters.update(value.id, value.revision, { description: 'Changed description' });
      }],
    ];

    for (const [label, mutate] of mutations) {
      const preview = (await requestPreview(app)).json();
      mutate();
      const response = await requestGeneration(app, preview.snapshotId);
      expect(response.statusCode, label).toBe(409);
      expect(response.json(), label).toEqual({ error: 'snapshot_stale' });
      expect(provider.chat, label).toEqual([]);
      expect(provider.text, label).toEqual([]);
      expect(repositories.messages.list(), label).toEqual(beforeMessages);
      expect(runtimeStates(repositories), label).toEqual([]);
    }
  });

  it('revalidates after asynchronous compilation before persisting a snapshot or accepting the user turn', async () => {
    const entered = deferred();
    const release = deferred();
    const tokenizerRuntime = unitTokenizerRuntime({
      async countMessages(messages) {
        entered.resolve();
        await release.promise;
        return messages.reduce((total, message) => total + message.content.length + 1, 0);
      },
    });
    const provider = capturedProvider();
    const { app, repositories } = await createPromptIntegrationContext({ provider, tokenizerRuntime });
    seedFullPromptGraph(repositories, 'chat');

    const pending = requestGeneration(app);
    const boundary = await Promise.race([
      entered.promise.then(() => 'compiling' as const),
      pending.then(() => 'completed_without_compiling' as const),
    ]);
    expect(boundary).toBe('compiling');
    if (boundary !== 'compiling') return;
    const preset = repositories.presets.get(integrationIds.chatPreset)!;
    expect(repositories.presets.update(preset.id, preset.revision, {
      settings: { ...preset.settings, temperature: 0.75 },
    })).toMatchObject({ ok: true });
    release.resolve();
    const response = await pending;

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'snapshot_stale' });
    expect(provider.chat).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
  });

  it('fails context overflow and tokenizer errors before creating snapshots, messages, or provider connections', async () => {
    const overflowProvider = capturedProvider();
    const overflowContext = await createPromptIntegrationContext({ provider: overflowProvider });
    seedFullPromptGraph(overflowContext.repositories, 'chat');
    const conversation = overflowContext.repositories.conversations.get(integrationIds.conversation)!;
    const updated = overflowContext.repositories.conversations.update(conversation.id, conversation.revision, { maxPromptTokens: 0 });
    expect(updated).toMatchObject({ ok: true });

    const overflow = await requestGeneration(overflowContext.app, undefined, { conversationRevision: 1 });

    expect(overflow.statusCode).toBe(422);
    expect(overflow.json()).toMatchObject({ error: 'context_overflow' });
    expect(overflowProvider.chat).toEqual([]);
    expect(overflowContext.repositories.generationSnapshots.list()).toEqual([]);
    expect(overflowContext.repositories.messages.list()).toHaveLength(2);

    const tokenizerProvider = capturedProvider();
    const tokenizerContext = await createPromptIntegrationContext({
      provider: tokenizerProvider,
      tokenizerRuntime: unitTokenizerRuntime({
        countMessages: async () => { throw new Error('private tokenizer failure'); },
      }),
    });
    seedFullPromptGraph(tokenizerContext.repositories, 'chat');

    const tokenizerFailure = await requestGeneration(tokenizerContext.app);

    expect(tokenizerFailure.statusCode).toBe(422);
    expect(tokenizerFailure.json()).toEqual({ error: 'tokenizer_error' });
    expect(tokenizerFailure.payload).not.toContain('private tokenizer failure');
    expect(tokenizerProvider.chat).toEqual([]);
    expect(tokenizerContext.repositories.generationSnapshots.list()).toEqual([]);
    expect(tokenizerContext.repositories.messages.list()).toHaveLength(2);
  });

  it('fails a malformed persisted Worldbook runtime state before snapshots, messages, or provider execution', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const state = repositories.worldbookRuntimeStates.create({
      id: '018f1000-0000-7000-8000-000000000121',
      conversationId: integrationIds.conversation,
      timedState: { messageIndex: null, sticky: [], cooldown: [] },
    });
    database.sqlite.prepare('UPDATE worldbook_runtime_states SET payload = ? WHERE id = ?')
      .run(JSON.stringify({ id: state.id, timedState: { malformed: true } }), state.id);

    const response = await requestGeneration(app);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'invalid_runtime_state' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
  });

  it('does not advance timed state when the provider fails or an in-flight generation is aborted', async () => {
    const failedProvider = capturedProvider();
    failedProvider.client.streamChat = async function* (request) {
      failedProvider.chat.push(structuredClone(request));
      throw new ProviderError('connection');
    };
    const failedContext = await createPromptIntegrationContext({ provider: failedProvider });
    seedFullPromptGraph(failedContext.repositories, 'chat');
    const failedPreview = (await requestPreview(failedContext.app)).json();

    const failed = await requestGeneration(failedContext.app, failedPreview.snapshotId);

    expect(parseEventNames(failed.payload)).toEqual(['started', 'failed']);
    expect(runtimeStates(failedContext.repositories)).toEqual([]);

    const entered = deferred();
    const abortedProvider = capturedProvider();
    abortedProvider.client.streamChat = async function* (request, signal) {
      abortedProvider.chat.push(structuredClone(request));
      yield { type: 'delta', text: 'Partial' };
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new ProviderError('aborted')), { once: true });
      });
    };
    const abortedContext = await createPromptIntegrationContext({ provider: abortedProvider });
    seedFullPromptGraph(abortedContext.repositories, 'chat');
    const abortedPreview = (await requestPreview(abortedContext.app)).json();
    const pending = requestGeneration(abortedContext.app, abortedPreview.snapshotId);
    await entered.promise;
    const cancellation = await abortedContext.app.inject({
      method: 'DELETE',
      url: `/api/generations/${abortedPreview.snapshotId}`,
    });
    expect(cancellation.statusCode).toBe(202);

    const aborted = await pending;

    expect(parseEventNames(aborted.payload)).toEqual(['started', 'delta', 'aborted']);
    expect(runtimeStates(abortedContext.repositories)).toEqual([]);
    expect(abortedContext.repositories.messageVariants.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Partial', status: 'aborted' }),
    ]));
  });

});
