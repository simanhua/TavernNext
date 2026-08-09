import { ProviderError } from '@tavernnext/provider-openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalHash } from '../src/services/prompt-snapshot-service.js';
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

  it('rejects mismatched, hash-tampered, malformed, and unsupported snapshots fail-closed', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const mismatchPreview = (await requestPreview(app)).json();
    const mismatch = await requestGeneration(app, mismatchPreview.snapshotId, { userText: 'Different input' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toEqual({ error: 'snapshot_mismatch' });

    const tamperedPreview = (await requestPreview(app)).json();
    const row = database.sqlite.prepare('SELECT payload FROM generation_snapshots WHERE id = ?').get(tamperedPreview.snapshotId);
    const entity = JSON.parse(String(row?.payload));
    entity.payload.compiledRequest.messages[0].content = 'TAMPERED';
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run(JSON.stringify(entity), tamperedPreview.snapshotId);
    const tampered = await requestGeneration(app, tamperedPreview.snapshotId);
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json()).toEqual({ error: 'snapshot_invalid' });

    const unsupportedPreview = (await requestPreview(app)).json();
    const unsupportedRow = database.sqlite.prepare('SELECT payload FROM generation_snapshots WHERE id = ?').get(unsupportedPreview.snapshotId);
    const unsupportedEntity = JSON.parse(String(unsupportedRow?.payload));
    unsupportedEntity.payload.schemaVersion = 999;
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run(JSON.stringify(unsupportedEntity), unsupportedPreview.snapshotId);
    const unsupported = await requestGeneration(app, unsupportedPreview.snapshotId);
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json()).toEqual({ error: 'snapshot_invalid' });

    const malformedPreview = (await requestPreview(app)).json();
    const malformedRow = database.sqlite.prepare('SELECT payload FROM generation_snapshots WHERE id = ?').get(malformedPreview.snapshotId);
    const malformedEntity = JSON.parse(String(malformedRow?.payload));
    malformedEntity.payload = { schemaVersion: 1 };
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run(JSON.stringify(malformedEntity), malformedPreview.snapshotId);
    const malformed = await requestGeneration(app, malformedPreview.snapshotId);
    expect(malformed.statusCode).toBe(409);
    expect(malformed.json()).toEqual({ error: 'snapshot_invalid' });

    const malformedEntityPreview = (await requestPreview(app)).json();
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run('{}', malformedEntityPreview.snapshotId);
    const malformedEntityResponse = await requestGeneration(app, malformedEntityPreview.snapshotId);
    expect(malformedEntityResponse.statusCode).toBe(409);
    expect(malformedEntityResponse.json()).toEqual({ error: 'snapshot_invalid' });

    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
    expect(runtimeStates(repositories)).toEqual([]);
  });

  it.each([
    ['token ledger', (payload: Record<string, unknown>) => {
      payload.tokenBreakdown = [{ source: 7, includedTokens: 0, omittedTokens: 0 }];
    }],
    ['Worldbook ledger', (payload: Record<string, unknown>) => {
      (payload.worldbook as Record<string, unknown>).activated = [{ entryKey: 'incomplete' }];
    }],
    ['tokenizer decision', (payload: Record<string, unknown>) => {
      (payload.tokenizerDecision as Record<string, unknown>).warning = 42;
    }],
  ] as const)('rejects a hash-consistent malformed nested %s before provider execution', async (_label, mutate) => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const preview = (await requestPreview(app)).json();
    const row = database.sqlite.prepare('SELECT payload FROM generation_snapshots WHERE id = ?').get(preview.snapshotId);
    const entity = JSON.parse(String(row?.payload));
    mutate(entity.payload);
    const { payloadHash: ignoredPayloadHash, ...withoutPayloadHash } = entity.payload;
    void ignoredPayloadHash;
    entity.payload.payloadHash = canonicalHash(withoutPayloadHash);
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run(JSON.stringify(entity), preview.snapshotId);

    const response = await requestGeneration(app, preview.snapshotId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'snapshot_invalid' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
    expect(runtimeStates(repositories)).toEqual([]);
  });

  it('accepts the existing generation API by atomically creating the same immutable snapshot', async () => {
    const provider = capturedProvider([{ type: 'completed', finishReason: 'stop' }]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestGeneration(app);

    expect(response.statusCode).toBe(200);
    expect(provider.chat).toHaveLength(1);
    expect(repositories.generationSnapshots.list()).toHaveLength(1);
    const snapshot = repositories.generationSnapshots.list()[0]!;
    expect(snapshot.payload).toMatchObject({
      input: previewPayload(),
      compiledRequest: provider.chat[0],
      compiledRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
