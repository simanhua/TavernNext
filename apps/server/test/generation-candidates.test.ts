import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  previewPayload,
  requestGeneration,
  seedFullPromptGraph,
  unitTokenizerRuntime,
} from './prompt-integration-fixtures.js';
import { createPromptSnapshotService } from '../src/services/prompt-snapshot-service.js';

afterEach(async () => { vi.useRealTimers(); await closePromptIntegrationContexts(); });

describe('two-phase generation candidates', () => {
  it('creates side-effect-free candidates, seals allowed patches once, and sends the sealed request', async () => {
    const { app, database, repositories, provider } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    const beforeMessages = repositories.messages.list();
    const create = () => app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/generation-candidates`,
      payload: previewPayload(),
    });

    const simultaneous = await Promise.all([create(), create()]);
    const response = simultaneous.find((item) => item.statusCode === 201)!;
    expect(simultaneous.map((item) => item.statusCode).sort()).toEqual([201, 409]);
    expect(response.statusCode).toBe(201);
    const candidate = response.json();
    expect(candidate).toMatchObject({
      candidateId: expect.any(String), expiresAt: expect.any(String), executableDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      entityRevisions: { globalGenerationConfig: expect.any(Object), extensionState: null, extensionTrust: [] },
      compiledRequest: { model: 'mock-model', messages: expect.any(Array) },
    });
    expect(candidate.snapshotId).toBeUndefined();
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.messages.list()).toEqual(beforeMessages);

    const messages = candidate.messages.map((message: { role: string; content: string }) => (
      message.content === 'Earlier answer' ? { ...message, content: 'Hook transformed answer' } : message
    ));
    const sealedResponse = await app.inject({
      method: 'POST', url: `/api/generation-candidates/${candidate.candidateId}/seal`,
      payload: { patch: { messages, stop: ['HOOK-STOP'] } },
    });
    expect(sealedResponse.statusCode).toBe(201);
    const sealed = sealedResponse.json();
    expect(sealed.compiledRequest.messages).toEqual(messages);
    expect(sealed.compiledRequest.stop).toEqual(['HOOK-STOP']);
    expect(repositories.generationSnapshots.list()).toHaveLength(1);
    expect(repositories.messages.list()).toEqual(beforeMessages);

    const replay = await app.inject({
      method: 'POST', url: `/api/generation-candidates/${candidate.candidateId}/seal`, payload: { patch: {} },
    });
    expect(replay.statusCode).toBe(409);
    const generation = await requestGeneration(app, sealed.snapshotId);
    expect(generation.statusCode).toBe(200);
    expect(provider.chat[0]?.messages).toEqual(messages);
    expect(provider.chat[0]?.stop).toEqual(['HOOK-STOP']);
    expect(database.sqlite.prepare(`
      SELECT snapshot_id FROM consumed_generation_snapshots WHERE snapshot_id = ?
    `).get(sealed.snapshotId)).toEqual({ snapshot_id: sealed.snapshotId });
    const restartedSnapshotService = createPromptSnapshotService({
      database, repositories, tokenizerRuntime: unitTokenizerRuntime(),
    });
    await expect(restartedSnapshotService.acceptExisting({
      conversationId: integrationIds.conversation,
      conversationRevision: previewPayload().conversationRevision,
      mode: 'normal',
      userText: previewPayload().userText,
      snapshotId: sealed.snapshotId,
    })).rejects.toMatchObject({ code: 'snapshot_mismatch' });
  });

  it('rejects illegal shapes and over-budget patches without persisting a snapshot', async () => {
    const { app, repositories } = await createPromptIntegrationContext();
    seedFullPromptGraph(repositories, 'chat');
    const candidate = (await app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/generation-candidates`,
      payload: previewPayload(),
    })).json();
    const illegal = await app.inject({
      method: 'POST', url: `/api/generation-candidates/${candidate.candidateId}/seal`,
      payload: { patch: { model: 'attacker-model' } },
    });
    expect(illegal.statusCode).toBe(400);
    const oversizedStop = await app.inject({
      method: 'POST', url: `/api/generation-candidates/${candidate.candidateId}/seal`,
      payload: { patch: { stop: Array.from({ length: 129 }, (_, index) => `STOP-${index}`) } },
    });
    expect(oversizedStop.statusCode).toBe(400);
    const oversized = await app.inject({
      method: 'POST', url: `/api/generation-candidates/${candidate.candidateId}/seal`,
      payload: { patch: { messages: [{ role: 'user', content: 'x'.repeat(10_000) }] } },
    });
    expect(oversized.statusCode).toBe(422);
    expect(repositories.generationSnapshots.list()).toEqual([]);
  });

  it('rejects expired candidates and entity revision changes', async () => {
    const expiredContext = await createPromptIntegrationContext();
    seedFullPromptGraph(expiredContext.repositories, 'chat');
    const expired = (await expiredContext.app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/generation-candidates`,
      payload: previewPayload(),
    })).json();
    const expiresAt = new Date(expired.expiresAt).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt + 1);
    const expiredSealPromise = expiredContext.app.inject({
      method: 'POST', url: `/api/generation-candidates/${expired.candidateId}/seal`, payload: { patch: {} },
    });
    await vi.runAllTimersAsync();
    const expiredSeal = await expiredSealPromise;
    expect(expiredSeal.statusCode).toBe(409);

    vi.useRealTimers();
    const changedContext = await createPromptIntegrationContext();
    seedFullPromptGraph(changedContext.repositories, 'chat');
    const changed = (await changedContext.app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/generation-candidates`,
      payload: previewPayload(),
    })).json();
    const conversation = changedContext.repositories.conversations.get(integrationIds.conversation)!;
    expect(changedContext.repositories.conversations.update(conversation.id, conversation.revision, { title: 'Changed' }))
      .toMatchObject({ ok: true });
    const changedSeal = await changedContext.app.inject({
      method: 'POST', url: `/api/generation-candidates/${changed.candidateId}/seal`, payload: { patch: {} },
    });
    expect(changedSeal.statusCode).toBe(409);
    expect(changedContext.repositories.generationSnapshots.list()).toEqual([]);
  });
});
