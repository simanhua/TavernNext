import { ProviderError, type OpenAICompatibleClient, type ProviderEvent } from '@tavernnext/provider-openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';
import { createGenerationService } from '../src/services/generation-service.js';
import type { SaveAgentRuntimeEvent } from '../src/services/save-agent-runtime.js';
import { createPromptSnapshotService } from '../src/services/prompt-snapshot-service.js';
import { MAX_MESSAGES_PER_CONVERSATION, MAX_VARIANTS_PER_RELATION } from '../src/db/repositories.js';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  requestGeneration,
  seedFullPromptGraph,
  unitTokenizerRuntime,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

function eventNames(payload: string): string[] {
  return payload.trim().split(/\r?\n\r?\n/).filter(Boolean).map((frame) => (
    frame.split(/\r?\n/).find((line) => line.startsWith('event: '))?.slice(7) ?? ''
  ));
}

function requestText(requests: unknown[]): string {
  return JSON.stringify(requests);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('generation modes and active variants', () => {
  it.each(['swipe', 'regenerate'] as const)('%s creates and selects one sibling variant without duplicating the assistant Message', async (mode) => {
    const provider = capturedProvider([
      { type: 'delta', text: `${mode} answer` },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const preset = repositories.presets.get(integrationIds.chatPreset)!;
    const prompts = preset.settings.prompts as Array<Record<string, unknown>>;
    const orders = preset.settings.prompt_order as Array<{ character_id: string; order: Array<Record<string, unknown>> }>;
    expect(repositories.presets.update(preset.id, preset.revision, {
      settings: {
        ...preset.settings,
        prompts: [...prompts, { identifier: `${mode}-only`, role: 'system', content: `MODE:${mode}`, generation_trigger: [mode] }],
        prompt_order: [{ ...orders[0]!, order: [...orders[0]!.order, { identifier: `${mode}-only`, enabled: true }] }],
      },
    })).toMatchObject({ ok: true });

    const response = await requestGeneration(app, undefined, {
      conversationRevision: 0,
      mode,
      userText: undefined,
      messageIndex: 2,
    });

    expect(response.statusCode).toBe(200);
    expect(eventNames(response.payload)).toEqual(['started', 'delta', 'completed']);
    const messages = repositories.messages.listByConversationId(integrationIds.conversation);
    expect(messages).toHaveLength(2);
    const assistant = messages[1]!;
    const variants = repositories.messageVariants.listByMessageId(assistant.id);
    expect(variants).toHaveLength(2);
    expect(variants.map((variant) => variant.content)).toEqual(['Earlier answer', `${mode} answer`]);
    expect(assistant.activeVariantId).toBe(variants[1]!.id);
    expect(requestText(provider.chat)).toContain(`MODE:${mode}`);
    expect(requestText(provider.chat)).toContain('Earlier question');
    expect(requestText(provider.chat)).not.toContain('Earlier answer');
    expect(repositories.conversations.get(integrationIds.conversation)?.revision).toBe(0);
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);
    const payload = repositories.generationSnapshots.list()[0]!.payload as Record<string, unknown>;
    expect(payload.input).toMatchObject({
      mode,
      targetMessageId: assistant.id,
      targetVariantId: integrationIds.historyVariant,
      continuationByteBoundary: null,
    });
  });

  it('continue appends to the active variant and records the prior UTF-8 byte boundary', async () => {
    const suffix = ' + 续🙂';
    const provider = capturedProvider([
      { type: 'delta', text: suffix },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestGeneration(app, undefined, {
      conversationRevision: 0,
      mode: 'continue',
      userText: undefined,
      messageIndex: 2,
    });

    expect(response.statusCode).toBe(200);
    expect(repositories.messages.listByConversationId(integrationIds.conversation)).toHaveLength(2);
    const variants = repositories.messageVariants.listByMessageId(integrationIds.historyAssistant);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      id: integrationIds.historyVariant,
      content: `Earlier answer${suffix}`,
      status: 'completed',
      continuationBoundaries: [Buffer.byteLength('Earlier answer', 'utf8')],
    });
    expect(requestText(provider.chat)).toContain('Earlier answer');
    expect(repositories.conversations.get(integrationIds.conversation)?.revision).toBe(0);
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);
    const payload = repositories.generationSnapshots.list()[0]!.payload as Record<string, unknown>;
    expect(payload.input).toMatchObject({
      mode: 'continue',
      targetMessageId: integrationIds.historyAssistant,
      targetVariantId: integrationIds.historyVariant,
      continuationByteBoundary: Buffer.byteLength('Earlier answer', 'utf8'),
    });
  });

  it.each(['normal', 'swipe', 'regenerate', 'continue'] as const)('Stop preserves partial content for %s without advancing timed state', async (mode) => {
    const requests: unknown[] = [];
    const client: OpenAICompatibleClient = {
      listModels: async () => [],
      async *streamChat(request, signal) {
        if (signal === undefined) throw new Error('Expected generation AbortSignal');
        requests.push(structuredClone(request));
        yield { type: 'delta', text: 'Partial' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new ProviderError('aborted');
      },
      async *streamText() { throw new Error('Unexpected Text request'); },
    };
    const { database, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    const promptSnapshots = createPromptSnapshotService({ database, repositories, tokenizerRuntime: unitTokenizerRuntime() });
    const service = createGenerationService({
      database,
      repositories,
      providerClientFactory: () => client,
      promptSnapshotService: promptSnapshots,
    });

    const started = await service.start({
      conversationId: integrationIds.conversation,
      conversationRevision: 0,
      mode,
      ...(mode === 'normal' ? { userText: 'New user turn' } : {}),
      seed: `abort-${mode}`,
      messageIndex: 2,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const iterator = started.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'started' });
    expect((await iterator.next()).value).toEqual({ type: 'delta', text: 'Partial' });
    expect(service.cancel(started.generationId)).toBe(true);
    const terminal: SaveAgentRuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      terminal.push(next.value);
    }
    expect(terminal.at(-1)).toEqual({ type: 'aborted' });
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);
    const assistant = repositories.messages.listByConversationId(integrationIds.conversation).at(-1)!;
    const active = repositories.messageVariants.listByMessageId(assistant.id)
      .find((variant) => variant.id === assistant.activeVariantId);
    expect(active).toMatchObject({ status: 'aborted' });
    expect(active?.content).toBe(mode === 'continue' ? 'Earlier answerPartial' : 'Partial');
    expect(requests).toHaveLength(1);
  });

  it('closes the provider iterator after completion, pre-next cancellation, and protocol failure', async () => {
    const { database, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    let currentStream: OpenAICompatibleClient['streamChat'];
    const service = createGenerationService({
      database,
      repositories,
      providerClientFactory: () => ({
        listModels: async () => [],
        streamChat(request, signal) { return currentStream(request, signal); },
        async *streamText() { throw new Error('Unexpected Text request'); },
      }),
      promptSnapshotService: createPromptSnapshotService({ database, repositories, tokenizerRuntime: unitTokenizerRuntime() }),
    });
    const start = async () => {
      const result = await service.start({
        conversationId: integrationIds.conversation,
        conversationRevision: 0,
        mode: 'swipe',
      });
      if (!result.ok) throw new Error(`Generation was rejected: ${result.reason}`);
      return result;
    };

    let completedCleanup = 0;
    currentStream = async function* () {
      try {
        yield { type: 'delta', text: 'Completed content' };
        yield { type: 'completed', finishReason: 'stop' };
      } finally {
        completedCleanup += 1;
      }
    };
    const completed = await start();
    const completedEvents: SaveAgentRuntimeEvent[] = [];
    for await (const event of completed.events) completedEvents.push(event);
    expect(completedEvents.map(({ type }) => type)).toEqual(['started', 'delta', 'completed']);
    expect(completedCleanup).toBe(1);

    let protocolCleanup = 0;
    currentStream = () => {
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() { return this; },
        async next() { return { done: true, value: undefined }; },
        async return() {
          protocolCleanup += 1;
          return { done: true, value: undefined };
        },
      };
      return iterator;
    };
    const protocol = await start();
    const protocolEvents: SaveAgentRuntimeEvent[] = [];
    for await (const event of protocol.events) protocolEvents.push(event);
    expect(protocolEvents.map(({ type }) => type)).toEqual(['started', 'failed']);
    expect(protocolCleanup).toBe(1);

    let cancelledCleanup = 0;
    currentStream = async function* () {
      try {
        yield { type: 'delta', text: 'partial' };
        await new Promise<never>(() => undefined);
      } finally {
        cancelledCleanup += 1;
      }
    };
    const cancelled = await start();
    const iterator = cancelled.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'started' });
    expect((await iterator.next()).value).toMatchObject({ type: 'delta' });
    expect(service.cancel(cancelled.generationId)).toBe(true);
    expect((await iterator.next()).value).toMatchObject({ type: 'aborted' });
    expect(cancelledCleanup).toBe(1);
  });

  it.each(['swipe', 'regenerate'] as const)('%s with zero deltas keeps the existing active variant and creates no empty sibling', async (mode) => {
    const provider = capturedProvider([{ type: 'completed', finishReason: 'stop' }]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestGeneration(app, undefined, {
      conversationRevision: 0, mode, userText: undefined,
    });

    expect(response.statusCode).toBe(200);
    const message = repositories.messages.get(integrationIds.historyAssistant)!;
    expect(message.activeVariantId).toBe(integrationIds.historyVariant);
    expect(repositories.messageVariants.listByMessageId(message.id)).toHaveLength(1);
  });

  it.each(['swipe', 'regenerate', 'continue'] as const)('%s preserves provider-failure partial content without timed-state advance', async (mode) => {
    const provider = capturedProvider();
    provider.client.streamChat = async function* (request) {
      provider.chat.push(structuredClone(request));
      yield { type: 'delta', text: 'Failure partial' };
      throw new ProviderError('connection');
    };
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestGeneration(app, undefined, {
      conversationRevision: 0, mode, userText: undefined,
    });

    expect(response.statusCode).toBe(200);
    expect(eventNames(response.payload)).toEqual(['started', 'delta', 'failed']);
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);
    const message = repositories.messages.get(integrationIds.historyAssistant)!;
    const active = repositories.messageVariants.get(message.activeVariantId!)!;
    expect(active.status).toBe('failed');
    expect(active.content).toBe(mode === 'continue'
      ? 'Earlier answerFailure partial'
      : 'Failure partial');
  });

  it.each(['swipe', 'regenerate'] as const)('%s provider failure before a delta creates no empty sibling', async (mode) => {
    const provider = capturedProvider();
    provider.client.streamChat = async function* (request) {
      provider.chat.push(structuredClone(request));
      throw new ProviderError('connection');
    };
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestGeneration(app, undefined, {
      conversationRevision: 0, mode, userText: undefined,
    });

    expect(eventNames(response.payload)).toEqual(['started', 'failed']);
    expect(repositories.messageVariants.listByMessageId(integrationIds.historyAssistant)).toHaveLength(1);
    expect(repositories.messages.get(integrationIds.historyAssistant)?.activeVariantId).toBe(integrationIds.historyVariant);
  });

  it('rejects non-normal context overflow and stale revisions before provider or variant mutation', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const conversation = repositories.conversations.get(integrationIds.conversation)!;
    const limited = repositories.conversations.update(conversation.id, conversation.revision, { maxPromptTokens: 0 });
    expect(limited.ok).toBe(true);

    const overflow = await requestGeneration(app, undefined, {
      conversationRevision: 1, mode: 'regenerate', userText: undefined,
    });
    expect(overflow.statusCode).toBe(422);
    expect(overflow.json()).toEqual({ error: 'context_overflow' });
    const stale = await requestGeneration(app, undefined, {
      conversationRevision: 0, mode: 'continue', userText: undefined,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'revision_conflict' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messageVariants.listByMessageId(integrationIds.historyAssistant)).toHaveLength(1);

    const service = createGenerationService({
      database,
      repositories,
      providerClientFactory: () => provider.client,
      promptSnapshotService: createPromptSnapshotService({ database, repositories, tokenizerRuntime: unitTokenizerRuntime() }),
    });
    const baseVariant = repositories.messageVariants.get(integrationIds.historyVariant)!;
    const originalVariantList = repositories.messageVariants.listByConversationId.bind(repositories.messageVariants);
    repositories.messageVariants.listByConversationId = () => [
      baseVariant,
      ...Array.from({ length: MAX_VARIANTS_PER_RELATION - 1 }, (_, index) => ({
        ...baseVariant,
        id: `aggregate-variant-${String(index).padStart(4, '0')}`,
        messageId: index % 2 === 0 ? integrationIds.historyUser : integrationIds.historyAssistant,
        ordinal: index + 1,
      })),
    ];

    for (const mode of ['swipe', 'regenerate', 'normal'] as const) {
      const result = await service.start({
        conversationId: integrationIds.conversation,
        conversationRevision: 1,
        mode,
        userText: mode === 'normal' ? 'Would cross the cap' : undefined,
      });
      expect(result).toEqual({ ok: false, reason: 'aggregate_limit' });
    }

    repositories.messageVariants.listByConversationId = originalVariantList;
    const originalMessageList = repositories.messages.listByConversationId.bind(repositories.messages);
    const baseMessage = repositories.messages.get(integrationIds.historyUser)!;
    repositories.messages.listByConversationId = () => [
      ...originalMessageList(integrationIds.conversation),
      ...Array.from({ length: MAX_MESSAGES_PER_CONVERSATION - 3 }, (_, index) => ({
        ...baseMessage,
        id: `aggregate-message-${String(index).padStart(4, '0')}`,
        activeVariantId: null,
        content: `headroom-${index}`,
      })),
    ];
    const normal = await service.start({
      conversationId: integrationIds.conversation,
      conversationRevision: 1,
      mode: 'normal',
      userText: 'Would add two rows',
    });
    expect(normal).toEqual({ ok: false, reason: 'aggregate_limit' });
    repositories.messages.listByConversationId = originalMessageList;
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.conversations.get(integrationIds.conversation)?.revision).toBe(1);
  });

  it('rolls back a completed sibling selection when terminal persistence faults, then exposes one failed partial boundary', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: 'Terminal partial' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const originalPersist = database.persist.bind(database);
    let persistCalls = 0;
    let injected = false;
    database.persist = () => {
      persistCalls += 1;
      if (!injected && persistCalls === 4) {
        injected = true;
        throw new Error('injected terminal active-variant fault');
      }
      originalPersist();
    };

    const response = await requestGeneration(app, undefined, {
      conversationRevision: 0, mode: 'swipe', userText: undefined,
    });

    expect(eventNames(response.payload)).toEqual(['started', 'delta', 'failed']);
    expect(injected).toBe(true);
    const message = repositories.messages.get(integrationIds.historyAssistant)!;
    const active = repositories.messageVariants.get(message.activeVariantId!)!;
    expect(active).toMatchObject({ content: 'Terminal partial', status: 'failed' });
    expect(repositories.messageVariants.listByMessageId(message.id)
      .filter((variant) => variant.status === 'completed').map((variant) => variant.id))
      .toEqual([integrationIds.historyVariant]);
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);
  });

  it('switches a variant through optimistic persistence only and validates ownership', async () => {
    const provider = capturedProvider();
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const sibling = repositories.messageVariants.create({
      id: '018f1000-0000-7000-8000-000000000150',
      messageId: integrationIds.historyAssistant,
      ordinal: 1,
      content: 'Stored sibling',
      status: 'completed',
      continuationBoundaries: [],
    });

    const switched = await app.inject({
      method: 'PUT',
      url: `/api/messages/${integrationIds.historyAssistant}/active-variant`,
      payload: { revision: 1, variantId: sibling.id },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ activeVariantId: sibling.id, revision: 2 });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);

    const foreignMessage = repositories.messages.create({
      id: '018f1000-0000-7000-8000-000000000151',
      conversationId: integrationIds.conversation,
      role: 'assistant', content: '', activeVariantId: null,
    });
    const foreign = repositories.messageVariants.create({
      id: '018f1000-0000-7000-8000-000000000152',
      messageId: foreignMessage.id,
      ordinal: 0,
      content: 'Foreign', status: 'completed', continuationBoundaries: [],
    });
    const wrongOwner = await app.inject({
      method: 'PUT',
      url: `/api/messages/${integrationIds.historyAssistant}/active-variant`,
      payload: { revision: 2, variantId: foreign.id },
    });
    expect(wrongOwner.statusCode).toBe(409);
    expect(wrongOwner.json()).toEqual({ error: 'variant_ownership_conflict' });
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/messages/${integrationIds.historyAssistant}/active-variant`,
      payload: { revision: 1, variantId: integrationIds.historyVariant },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'conflict' });
  });

  it('rejects variant switching, message mutation, and conversation deletion while the generation lock is active', async () => {
    const entered = deferred();
    const release = deferred();
    const provider = capturedProvider();
    provider.client.streamChat = async function* (request) {
      provider.chat.push(structuredClone(request));
      entered.resolve();
      await release.promise;
      yield { type: 'completed', finishReason: 'stop' };
    };
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const generation = requestGeneration(app, undefined, {
      conversationRevision: 0, mode: 'swipe', userText: undefined,
    });
    await entered.promise;

    const requests = await Promise.all([
      app.inject({
        method: 'PUT',
        url: `/api/messages/${integrationIds.historyAssistant}/active-variant`,
        payload: { revision: 1, variantId: integrationIds.historyVariant },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/messages/${integrationIds.historyAssistant}`,
        payload: { revision: 1, patch: { content: 'blocked' } },
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/messages/${integrationIds.historyAssistant}?revision=1`,
      }),
    ]);
    expect(requests.map((response) => ({ status: response.statusCode, body: response.json() }))).toEqual([
      { status: 409, body: { error: 'generation_active' } },
      { status: 409, body: { error: 'generation_active' } },
      { status: 409, body: { error: 'generation_active' } },
    ]);
    const conversationDelete = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${integrationIds.conversation}?revision=0`,
    });
    expect(conversationDelete.statusCode).toBe(409);
    expect(conversationDelete.json()).toEqual({ error: 'generation_active' });
    release.resolve();
    expect((await generation).statusCode).toBe(200);
  });
});
