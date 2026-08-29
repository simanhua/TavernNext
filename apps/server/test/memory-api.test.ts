import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-memory-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const character = repositories.characters.create({
    id: randomUUID(), name: 'Aster', description: '', personality: '', scenario: '',
    firstMessage: '', alternateGreetings: [], tags: [],
  });
  const persona = repositories.personas.create({
    id: randomUUID(), name: 'Traveler', description: '', isDefault: true,
  });
  const conversation = repositories.conversations.create({
    id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Memory Save',
  });
  repositories.saveMemoryConfigurations.create({ id: randomUUID(), conversationId: conversation.id, enabled: true });
  const memory = repositories.saveMemories.create({
    id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'near',
    summary: 'The gate opened.', detail: '', entities: [], salience: 0.7, confidence: 0.8,
    sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
    sourceMemoryIds: [], supersedesId: null, contentHash: 'c'.repeat(64), tokenCount: 6,
  });
  const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
  apps.push(app);
  await app.ready();
  return { app, database, repositories, conversation, memory };
}

describe('Memory Center API', () => {
  it('rejects pinning beyond the bounded Save Memory pin limit', async () => {
    const { app, database, repositories, conversation, memory } = await context();
    database.transaction(() => {
      for (let index = 0; index < 128; index += 1) {
        repositories.saveMemories.create({
          id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'far',
          summary: `Pinned memory ${index}`, detail: '', entities: [], salience: 0.5, confidence: 0.8,
          sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
          sourceMemoryIds: [], supersedesId: null,
          contentHash: index.toString(16).padStart(64, '0'), tokenCount: 4, pinned: true,
        });
      }
    });

    const response = await app.inject({
      method: 'PATCH', url: `/api/memories/${memory.id}`,
      payload: { revision: memory.revision, pinned: true, excluded: false },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'memory_pin_limit' });
  });

  it('pages Save Memory with a stable total count', async () => {
    const { app, repositories, conversation } = await context();
    for (let index = 0; index < 3; index += 1) {
      repositories.saveMemories.create({
        id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'near',
        summary: `Paged memory ${index}`, detail: '', entities: [], salience: 0.5, confidence: 0.8,
        sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
        sourceMemoryIds: [], supersedesId: null,
        contentHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), tokenCount: 4,
      });
    }

    const response = await app.inject({
      method: 'GET', url: `/api/conversations/${conversation.id}/memories?page=2&pageSize=2`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      memories: [expect.any(Object), expect.any(Object)],
      pagination: { page: 2, pageSize: 2, total: 4, totalPages: 2 },
    });
  });

  it('lists, marks, deletes, and rebuilds Save Memory', async () => {
    const { app, repositories, conversation, memory } = await context();
    const listed = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/memories` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ configuration: { enabled: true }, memories: [{ id: memory.id }] });

    const marked = await app.inject({
      method: 'PATCH', url: `/api/memories/${memory.id}`,
      payload: { revision: memory.revision, pinned: true, excluded: true },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ revision: 1, pinned: true, excluded: true });

    const rebuild = await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/memory-index/rebuild`,
    });
    expect(rebuild.statusCode).toBe(202);
    expect(repositories.memoryJobs.listByConversationId(conversation.id)).toEqual([
      expect.objectContaining({ kind: 'rebuild-index', status: 'pending' }),
    ]);

    const settings = repositories.saveMemoryConfigurations.getByConversationId(conversation.id)!;
    const disabled = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversation.id}/memory-settings`,
      payload: { revision: settings.revision, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false, disabledAt: expect.any(String) });

    const failedJob = repositories.memoryJobs.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'extract-turn', status: 'failed',
      attempts: 4, nextAttemptAt: null, payload: {}, lastError: 'bad output',
    });
    const retried = await app.inject({ method: 'POST', url: `/api/memory-jobs/${failedJob.id}/retry` });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({ status: 'pending', attempts: 0, lastError: null });

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/memories/${memory.id}?revision=1`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(repositories.saveMemories.get(memory.id)).toBeUndefined();
  });

  it('updates the global OpenAI-compatible embedding configuration without exposing a credential', async () => {
    const { app } = await context();
    const updated = await app.inject({
      method: 'PUT', url: '/api/global-embedding-config',
      payload: {
        revision: 0, enabled: true, baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'embedding-model', secretRef: 'browser:embedding', dimensions: 768,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual(expect.objectContaining({
      revision: 1, enabled: true, model: 'embedding-model', dimensions: 768, configured: true,
    }));
    expect(updated.json()).not.toHaveProperty('secretRef');
  });

  it('removes Variant-owned and consolidated memories when the source Message is deleted', async () => {
    const { app, repositories, conversation } = await context();
    const message = repositories.messages.create({
      id: randomUUID(), conversationId: conversation.id, role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: randomUUID(), messageId: message.id, content: 'Branch', status: 'completed', ordinal: 0,
    });
    expect(repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id }).ok).toBe(true);
    const source = repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'near', summary: 'Branch memory', detail: '',
      entities: [], salience: 1, confidence: 1, sourceMessageId: message.id, sourceVariantId: variant.id,
      sourceTransitionId: null, sourceAgentRunId: null, sourceMemoryIds: [], supersedesId: null,
      contentHash: '7'.repeat(64), tokenCount: 4,
    });
    const far = repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'far', summary: 'Far branch memory', detail: '',
      entities: [], salience: 1, confidence: 1, sourceMessageId: null, sourceVariantId: null,
      sourceTransitionId: null, sourceAgentRunId: null, sourceMemoryIds: [source.id], supersedesId: null,
      contentHash: '8'.repeat(64), tokenCount: 4,
    });

    const deleted = await app.inject({ method: 'DELETE', url: `/api/messages/${message.id}?revision=1` });
    expect(deleted.statusCode).toBe(204);
    expect(repositories.saveMemories.get(source.id)).toBeUndefined();
    expect(repositories.saveMemories.get(far.id)).toBeUndefined();
  });
});
