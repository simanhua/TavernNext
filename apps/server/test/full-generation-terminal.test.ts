import { ProviderError } from '@tavernnext/provider-openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';
import type { Repositories } from '../src/db/repositories.js';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  requestGeneration,
  requestPreview,
  seedFullPromptGraph,
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

describe('full prompt generation terminal boundaries', () => {
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
