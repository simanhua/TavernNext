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
    const conversation = repositories.conversations.get(integrationIds.conversation)!;
    expect(repositories.conversations.update(conversation.id, conversation.revision, {
      authorNote: 'CONFIGURED-AUTHOR-NOTE', authorNotePosition: 1, authorNoteDepth: 1, authorNoteRole: 2,
    })).toMatchObject({ ok: true });
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
      { id: '018f1000-0000-7000-8000-000000000131', sourceUid: 'before-alias', position: 'before_char', content: 'BEFORE-ALIAS' },
      { id: '018f1000-0000-7000-8000-000000000132', sourceUid: 'after-alias', position: 'after_char', content: 'AFTER-ALIAS' },
      { id: '018f1000-0000-7000-8000-000000000133', sourceUid: 'an-top-alias', position: 'an_top', content: 'AN-TOP-ALIAS' },
      { id: '018f1000-0000-7000-8000-000000000134', sourceUid: 'an-bottom-alias', position: 'an_bottom', content: 'AN-BOTTOM-ALIAS' },
      { id: '018f1000-0000-7000-8000-000000000135', sourceUid: 'at-depth-alias', position: 'at_depth', content: 'AT-DEPTH-ALIAS', depth: 1, role: 1 },
      { id: '018f1000-0000-7000-8000-000000000136', sourceUid: 'em-top-alias', position: 'em_top', content: '<START>\nTraveler: EM-TOP-ALIAS\nAster: EM-TOP-ALIAS-A' },
      { id: '018f1000-0000-7000-8000-000000000137', sourceUid: 'em-bottom-alias', position: 'em_bottom', content: '<START>\nTraveler: EM-BOTTOM-ALIAS\nAster: EM-BOTTOM-ALIAS-A' },
      { id: '018f1000-0000-7000-8000-000000000138', sourceUid: 'outlet-alias', position: 'outlet', content: 'OUTLET-ALIAS', outletName: 'sidebar' },
    ];
    for (const [sourceOrdinal, entry] of entries.entries()) {
      repositories.worldbookEntries.create({
        worldbookId: integrationIds.globalBook,
        sourceOrdinal, keys: [], constant: true,
        ...entry,
      });
    }

    const previewResponse = await requestPreview(app, { conversationRevision: 1 });

    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json();
    const executable = mode === 'chat'
      ? JSON.stringify(preview.messages)
      : String(preview.text);
    if (mode === 'chat') {
      expect(preview.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('CONFIGURED-AUTHOR-NOTE'),
        }),
      ]));
    } else {
      expect(executable).toContain('CONFIGURED-AUTHOR-NOTE');
    }
    for (const value of [
      'BEFORE-ALIAS', 'AFTER-ALIAS', 'AN-TOP-ALIAS', 'AN-BOTTOM-ALIAS',
      'AT-DEPTH-ALIAS', 'EM-TOP-ALIAS', 'EM-BOTTOM-ALIAS',
    ]) expect(executable).toContain(value);
    expect(executable).toContain('AT-DEPTH');
    expect(executable.indexOf('EM-TOP')).toBeLessThan(executable.indexOf('CARD-EXAMPLE'));
    expect(executable.indexOf('CARD-EXAMPLE')).toBeLessThan(executable.indexOf('EM-BOTTOM'));
    expect(executable).not.toContain('OUTLET-ONLY');
    expect(preview.worldInfoOutlets).toEqual({ sidebar: 'OUTLET-ONLY\nOUTLET-ALIAS' });
    const generation = await requestGeneration(app, preview.snapshotId, { conversationRevision: 1 });
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

  it('scans only the dedicated Character depth prompt and surfaces every loaded compatibility warning', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    const character = repositories.characters.get(integrationIds.character)!;
    expect(repositories.characters.update(character.id, character.revision, {
      depthPrompt: 'Typed Character depth prompt',
      extensions: { depth_prompt: { prompt: 'FORGED NON-EXECUTABLE DEPTH PROMPT' }, audit_secret: 'MUST-NOT-ENTER-AUDIT' },
      postHistoryInstructions: 'PHI-only',
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['character_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    const conversation = repositories.conversations.get(integrationIds.conversation)!;
    expect(repositories.conversations.update(conversation.id, conversation.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['conversation_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    const persona = repositories.personas.get(integrationIds.persona)!;
    expect(repositories.personas.update(persona.id, persona.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['persona_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    const provider = repositories.providerProfiles.get(integrationIds.provider)!;
    expect(repositories.providerProfiles.update(provider.id, provider.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['provider_compat_warning'], parserVersion: '1',
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
    const history = repositories.messages.get(integrationIds.historyUser)!;
    expect(repositories.messages.update(history.id, history.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['message_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    const variant = repositories.messageVariants.get(integrationIds.historyVariant)!;
    expect(repositories.messageVariants.update(variant.id, variant.revision, {
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['variant_compat_warning'], parserVersion: '1',
      },
    })).toMatchObject({ ok: true });
    repositories.worldbookEntries.create({
      id: '018f1000-0000-7000-8000-000000000122', worldbookId: integrationIds.globalBook,
      sourceUid: 'typed-depth', sourceOrdinal: 3, keys: ['Typed Character depth prompt'],
      content: 'TYPED-DEPTH-MATCH', matchCharacterDepthPrompt: true,
      compatibility: {
        sourceFormat: 'test', rawPayload: {}, unknownFields: {},
        compatWarnings: ['entry_compat_warning'], parserVersion: '1',
      },
    });
    repositories.worldbookEntries.create({
      id: '018f1000-0000-7000-8000-000000000123', worldbookId: integrationIds.globalBook,
      sourceUid: 'phi-depth', sourceOrdinal: 4, keys: ['PHI-only'],
      content: 'PHI-MUST-NOT-MATCH', matchCharacterDepthPrompt: true,
    });

    const response = await requestPreview(app, { conversationRevision: 1 });

    expect(response.statusCode).toBe(201);
    const preview = response.json();
    expect(preview.worldbook.activated.map((entry: { content: string }) => entry.content)).toContain('TYPED-DEPTH-MATCH');
    expect(preview.worldbook.activated.map((entry: { content: string }) => entry.content)).not.toContain('PHI-MUST-NOT-MATCH');
    expect(JSON.stringify(preview.executable)).not.toContain('MUST-NOT-ENTER-AUDIT');
    expect(JSON.stringify(preview.executable)).not.toContain('FORGED NON-EXECUTABLE DEPTH PROMPT');
    expect(preview.warnings).toEqual(expect.arrayContaining([
      { code: 'compatibility_warning', message: 'conversation_compat_warning', source: `conversation:${integrationIds.conversation}` },
      { code: 'compatibility_warning', message: 'character_compat_warning', source: `character:${integrationIds.character}` },
      { code: 'compatibility_warning', message: 'persona_compat_warning', source: `persona:${integrationIds.persona}` },
      { code: 'compatibility_warning', message: 'provider_compat_warning', source: `provider:${integrationIds.provider}` },
      { code: 'compatibility_warning', message: 'preset_compat_warning', source: `preset:${integrationIds.chatPreset}` },
      { code: 'compatibility_warning', message: 'worldbook_compat_warning', source: `worldbook:${integrationIds.globalBook}` },
      { code: 'compatibility_warning', message: 'entry_compat_warning', source: 'worldbook-entry:018f1000-0000-7000-8000-000000000122' },
      { code: 'compatibility_warning', message: 'message_compat_warning', source: `message:${integrationIds.historyUser}` },
      { code: 'compatibility_warning', message: 'variant_compat_warning', source: `variant:${integrationIds.historyVariant}` },
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

});
