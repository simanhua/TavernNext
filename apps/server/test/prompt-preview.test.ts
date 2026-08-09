import { TokenizerId } from '@tavernnext/tokenizer-engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  requestPreview,
  seedFullPromptGraph,
  unitTokenizerRuntime,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

describe('full prompt preview', () => {
  it('returns the complete immutable Chat snapshot without mutating chat or timed state', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    const seeded = seedFullPromptGraph(repositories, 'chat');
    const before = {
      conversation: repositories.conversations.get(integrationIds.conversation),
      messages: repositories.messages.list(),
      variants: repositories.messageVariants.list(),
      timedState: repositories.worldbookRuntimeStates.list(),
    };

    const firstResponse = await requestPreview(app);
    const secondResponse = await requestPreview(app);

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    const first = firstResponse.json();
    const second = secondResponse.json();
    expect(first).toMatchObject({
      snapshotId: expect.any(String),
      schemaVersion: 3,
      kind: 'chat',
      messages: expect.any(Array),
      stop: expect.any(Array),
      tokenBreakdown: expect.any(Array),
      totalTokens: expect.any(Number),
      compiledRequest: {
        model: seeded.provider.model,
        messages: expect.any(Array),
        temperature: 0.25,
        maxTokens: 64,
        stop: expect.any(Array),
      },
      compiledRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      worldbook: {
        activated: expect.any(Array),
        excluded: expect.any(Array),
        timedState: expect.any(Object),
        tokenUsage: expect.any(Object),
      },
      tokenizerDecision: {
        requestedId: TokenizerId.NONE,
        tokenizerId: TokenizerId.NONE,
        tokenizerName: 'None / Estimated',
      },
      warnings: expect.any(Array),
      seed: 'snapshot-seed',
      messageIndex: 2,
      entityRevisions: expect.any(Object),
    });
    expect(first.compiledRequest.messages).toEqual(first.messages);
    expect(first.compiledRequest.stop).toEqual(first.stop);
    expect(first.worldbook.activated.map((entry: { content: string }) => entry.content)).toEqual([
      'GLOBAL-LORE',
      'CHARACTER-LORE',
      'EMBEDDED-LORE',
      'CONVERSATION-LORE',
    ]);
    expect(first.worldbook.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceUid: 'disabled', reason: 'entry_disabled' }),
    ]));
    expect(first.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Open the portal' }),
    ]));
    expect(first.tokenBreakdown.length).toBeGreaterThan(0);
    expect(first.totalTokens).toBeGreaterThan(0);

    expect({
      compiledRequest: second.compiledRequest,
      compiledRequestHash: second.compiledRequestHash,
      worldbook: second.worldbook,
      tokenizerDecision: second.tokenizerDecision,
      warnings: second.warnings,
      seed: second.seed,
      messageIndex: second.messageIndex,
      entityRevisions: second.entityRevisions,
    }).toEqual({
      compiledRequest: first.compiledRequest,
      compiledRequestHash: first.compiledRequestHash,
      worldbook: first.worldbook,
      tokenizerDecision: first.tokenizerDecision,
      warnings: first.warnings,
      seed: first.seed,
      messageIndex: first.messageIndex,
      entityRevisions: first.entityRevisions,
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);

    expect(repositories.conversations.get(integrationIds.conversation)).toEqual(before.conversation);
    expect(repositories.messages.list()).toEqual(before.messages);
    expect(repositories.messageVariants.list()).toEqual(before.variants);
    expect(repositories.worldbookRuntimeStates.list())
      .toEqual(before.timedState);
    expect(repositories.generationSnapshots.list()).toHaveLength(2);

    const serialized = JSON.stringify({ response: first, rows: repositories.generationSnapshots.list() });
    for (const secret of [
      'TOP-SECRET-API-KEY-REFERENCE',
      'TOP-SECRET-HEADER-REFERENCE',
      'TOP-SECRET-COMPATIBILITY-VALUE',
      'TOP-SECRET-PRESET-COMPATIBILITY-VALUE',
    ]) expect(serialized).not.toContain(secret);
  });

  it('returns exact Text output and companion-preset revision references', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'text');

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(201);
    const preview = response.json();
    expect(preview).toMatchObject({
      kind: 'text',
      text: expect.any(String),
      stop: expect.any(Array),
      compiledRequest: {
        model: 'mock-model',
        prompt: expect.any(String),
        temperature: 0.4,
        maxTokens: 72,
        stop: expect.any(Array),
      },
      entityRevisions: {
        presets: expect.arrayContaining([
          { id: integrationIds.textPreset, revision: 0, kind: 'text' },
          { id: integrationIds.contextPreset, revision: 0, kind: 'context' },
          { id: integrationIds.instructPreset, revision: 0, kind: 'instruct' },
          { id: integrationIds.systemPreset, revision: 0, kind: 'system' },
        ]),
      },
    });
    expect(preview.compiledRequest.prompt).toBe(preview.text);
    expect(preview.stop.some((stop: string) => stop.trim() === '<STOP>')).toBe(true);
    expect(preview.text).toContain('GLOBAL-LORE');
    expect(preview.text).toContain('CONVERSATION-LORE');
    expect(preview.text).toContain('Open the portal');
  });

  it.each([
    ['Instruct', 'instructPresetId'],
    ['System', 'systemPresetId'],
  ] as const)('rejects Text execution without an explicitly selected %s companion', async (_label, field) => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'text');
    const conversation = repositories.conversations.get(integrationIds.conversation)!;
    const patch = field === 'instructPresetId'
      ? { instructPresetId: undefined }
      : { systemPresetId: undefined };
    expect(repositories.conversations.update(conversation.id, conversation.revision, patch))
      .toMatchObject({ ok: true });

    const response = await requestPreview(app, { conversationRevision: 1 });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'preset_not_configured' });
    expect(repositories.generationSnapshots.list()).toEqual([]);
  });

  it('persists and explains the final tokenizer decision after deterministic fallback without network', async () => {
    let fellBack = false;
    const tokenizerRuntime = unitTokenizerRuntime({
      selectTokenizer(input) {
        return {
          requestedId: input.requestedId,
          tokenizerId: TokenizerId.QWEN2,
          tokenizerName: 'Qwen2',
          model: input.model,
          api: input.api,
        };
      },
      async countText(text, decision) {
        if (!fellBack) {
          fellBack = true;
          decision.fallbackFrom = TokenizerId.QWEN2;
          decision.fallbackTokenizerId = TokenizerId.LLAMA3;
          decision.tokenizerId = TokenizerId.LLAMA3;
          decision.tokenizerName = 'Llama 3';
          decision.warning = 'Qwen2 model is unavailable; using Llama 3.';
        }
        return text.length;
      },
    });
    const { app, repositories } = await createPromptIntegrationContext({ tokenizerRuntime });
    seedFullPromptGraph(repositories, 'chat');
    const preset = repositories.presets.get(integrationIds.chatPreset)!;
    expect(repositories.presets.update(preset.id, preset.revision, {
      settings: { ...preset.settings, tokenizer: TokenizerId.QWEN2 },
    })).toMatchObject({ ok: true });

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      tokenizerDecision: {
        requestedId: TokenizerId.QWEN2,
        tokenizerId: TokenizerId.LLAMA3,
        fallbackFrom: TokenizerId.QWEN2,
        fallbackTokenizerId: TokenizerId.LLAMA3,
        warning: 'Qwen2 model is unavailable; using Llama 3.',
      },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'tokenizer_fallback' }),
      ]),
    });
    expect(repositories.generationSnapshots.list()[0]?.payload).toMatchObject({
      tokenizerDecision: { tokenizerId: TokenizerId.LLAMA3 },
    });
  });

  it('rejects a tokenizer runtime that leaves BEST_MATCH unresolved', async () => {
    const tokenizerRuntime = unitTokenizerRuntime({
      selectTokenizer() {
        return {
          requestedId: TokenizerId.BEST_MATCH,
          tokenizerId: TokenizerId.BEST_MATCH,
          tokenizerName: 'Best Match',
        };
      },
    });
    const { app, repositories } = await createPromptIntegrationContext({ tokenizerRuntime });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'tokenizer_error' });
    expect(repositories.generationSnapshots.list()).toEqual([]);
  });
});
