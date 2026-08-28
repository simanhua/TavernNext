import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { createSaveMemoryService } from '../src/services/save-memory-service.js';
import { TEST_REPOSITORY_OPTIONS } from './test-integrity-key.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seeded() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-memory-'));
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
  return { repositories, conversation };
}

describe('Save Memory service', () => {
  it('turns a pending extraction job into validated Save Memories', async () => {
    const { repositories, conversation } = await seeded();
    const service = createSaveMemoryService(repositories);
    repositories.memoryJobs.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'extract-turn', status: 'pending',
      attempts: 0, nextAttemptAt: null, lastError: null,
      payload: {
        sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
        playerInput: 'Will you return?', narrative: 'Aster promised to return before dawn.',
      },
    });

    expect(await service.processReadyJobs(async () => ({ memories: [
      {
        kind: 'episode', summary: 'Aster promised to return.', detail: 'The promise was made before dawn.',
        entities: [{ kind: 'character', id: 'aster', label: 'Aster' }], salience: 0.8, confidence: 0.9,
      },
      {
        kind: 'commitment', summary: 'Aster will return before dawn.', detail: '',
        entities: [{ kind: 'character', id: 'aster', label: 'Aster' }], salience: 1, confidence: 0.95,
      },
    ] }))).toEqual({ completed: 1, failed: 0 });

    expect(repositories.saveMemories.listByConversationId(conversation.id)).toEqual([
      expect.objectContaining({ kind: 'episode', tier: 'near', summary: 'Aster promised to return.' }),
      expect.objectContaining({ kind: 'commitment', tier: 'near', summary: 'Aster will return before dawn.' }),
    ]);
    expect(repositories.memoryJobs.listByConversationId(conversation.id)).toEqual([
      expect.objectContaining({ status: 'completed', attempts: 1, lastError: null }),
    ]);
  });

  it('backs off a failed extraction without corrupting the Save', async () => {
    const { repositories, conversation } = await seeded();
    const service = createSaveMemoryService(repositories);
    repositories.memoryJobs.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'extract-turn', status: 'pending',
      attempts: 0, nextAttemptAt: null, lastError: null, payload: {},
    });
    const now = new Date('2026-08-28T12:00:00.000Z');

    expect(await service.processReadyJobs(async () => { throw new Error('temporary outage'); }, now))
      .toEqual({ completed: 0, failed: 1 });
    expect(repositories.saveMemories.listByConversationId(conversation.id)).toEqual([]);
    expect(repositories.memoryJobs.listByConversationId(conversation.id)).toEqual([
      expect.objectContaining({
        status: 'pending', attempts: 1, nextAttemptAt: '2026-08-28T12:00:05.000Z', lastError: 'temporary outage',
      }),
    ]);
  });

  it('recalls recent and relevant memories only from the active Variant', async () => {
    const { repositories, conversation } = await seeded();
    const service = createSaveMemoryService(repositories);
    const message = repositories.messages.create({
      id: randomUUID(), conversationId: conversation.id, role: 'assistant', content: '', activeVariantId: null,
    });
    const abandoned = repositories.messageVariants.create({
      id: randomUUID(), messageId: message.id, content: 'The abandoned path.', status: 'completed', ordinal: 0,
    });
    const active = repositories.messageVariants.create({
      id: randomUUID(), messageId: message.id, content: 'The chosen path.', status: 'completed', ordinal: 1,
    });
    expect(repositories.messages.update(message.id, message.revision, { activeVariantId: active.id }).ok).toBe(true);
    const memory = (variantId: string, summary: string, salience: number) => repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'commitment', tier: 'near', summary, detail: '',
      entities: [{ kind: 'character', id: 'aster', label: '阿斯特' }], salience, confidence: 0.9,
      sourceMessageId: message.id, sourceVariantId: variantId, sourceTransitionId: null, sourceAgentRunId: null,
      sourceMemoryIds: [], supersedesId: null, contentHash: 'b'.repeat(64), tokenCount: 12,
    });
    memory(abandoned.id, '阿斯特放弃了黎明前返回的誓言。', 1);
    const chosen = memory(active.id, '阿斯特承诺在黎明前返回。', 0.9);

    expect(service.recall({ conversationId: conversation.id, query: '黎明誓言', limit: 6 }).memories)
      .toEqual([expect.objectContaining({ id: chosen.id, summary: '阿斯特承诺在黎明前返回。' })]);
  });

  it('fuses BM25 and dense rankings without comparing their raw score scales', async () => {
    const { repositories, conversation } = await seeded();
    const first = repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'discovery', tier: 'near',
      summary: 'The archive key is beneath the clock.', detail: '', entities: [], salience: 0.5, confidence: 0.8,
      sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
      sourceMemoryIds: [], supersedesId: null, contentHash: 'e'.repeat(64), tokenCount: 8,
    });
    const semantic = repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'relationship_event', tier: 'near',
      summary: 'Aster forgave the traveler.', detail: '', entities: [], salience: 0.5, confidence: 0.8,
      sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
      sourceMemoryIds: [], supersedesId: null, contentHash: 'f'.repeat(64), tokenCount: 8,
    });
    const service = createSaveMemoryService(repositories, async () => new Map([
      [semantic.id, 0.99], [first.id, 0.01],
    ]));

    const recalled = await service.recallHybrid({
      conversationId: conversation.id, query: 'archive clock reconciliation', limit: 4,
    });
    expect(recalled.memories.map((memory) => memory.id)).toEqual(expect.arrayContaining([first.id, semantic.id]));
    expect(recalled.mode).toBe('hybrid');
  });

  it('keeps the two most recent memories in automatic recall before filling relevant slots', async () => {
    const { repositories, conversation } = await seeded();
    const create = (summary: string) => repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'near', summary, detail: '',
      entities: [], salience: 0.5, confidence: 0.8,
      sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
      sourceMemoryIds: [], supersedesId: null,
      contentHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), tokenCount: 8,
    });
    for (let index = 0; index < 8; index += 1) create(`archive clock clue ${index}`);
    const recent = [create('quiet recent scene one'), create('quiet recent scene two')];

    const recalled = createSaveMemoryService(repositories).recall({
      conversationId: conversation.id, query: 'archive clock', limit: 6,
    }).memories;
    expect(recalled.slice(0, 2).map((memory) => memory.id)).toEqual(recent.map((memory) => memory.id));
    expect(recalled).toHaveLength(6);
  });

  it('consolidates old near memories into source-linked far memory', async () => {
    const { repositories, conversation } = await seeded();
    const source = (summary: string) => repositories.saveMemories.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'near', summary, detail: '',
      entities: [], salience: 0.5, confidence: 0.8,
      sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
      sourceMemoryIds: [], supersedesId: null, contentHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      tokenCount: 3_500,
    });
    const old = source('The journey began.');
    source('The journey continued.');
    repositories.memoryJobs.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'consolidate', status: 'pending',
      attempts: 0, nextAttemptAt: null, lastError: null, payload: { sourceMemoryIds: [old.id] },
    });
    const service = createSaveMemoryService(repositories);

    expect(await service.processReadyJobs(async () => ({ memories: [{
      kind: 'episode', summary: 'The early journey.', detail: 'The journey began and established the route.',
      entities: [], salience: 0.7, confidence: 0.9,
    }] }))).toEqual({ completed: 1, failed: 0 });
    expect(repositories.saveMemories.get(old.id)).toMatchObject({ status: 'archived' });
    expect(repositories.saveMemories.listByConversationId(conversation.id)).toContainEqual(expect.objectContaining({
      tier: 'far', sourceMemoryIds: [old.id], summary: 'The early journey.',
    }));
    expect(service.recall({ conversationId: conversation.id, query: 'early journey', limit: 4 }).memories)
      .toContainEqual(expect.objectContaining({ tier: 'far', summary: 'The early journey.' }));
  });

  it('carries the frozen extractor configuration into automatically queued consolidation', async () => {
    const { repositories, conversation } = await seeded();
    for (const summary of ['The first long chapter.', 'The second long chapter.']) {
      repositories.saveMemories.create({
        id: randomUUID(), conversationId: conversation.id, kind: 'episode', tier: 'near', summary, detail: '',
        entities: [], salience: 0.5, confidence: 0.8,
        sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
        sourceMemoryIds: [], supersedesId: null,
        contentHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), tokenCount: 3_500,
      });
    }
    repositories.memoryJobs.create({
      id: randomUUID(), conversationId: conversation.id, kind: 'extract-turn', status: 'pending',
      attempts: 0, nextAttemptAt: null, lastError: null,
      payload: {
        provider: { id: 'frozen-provider', revision: 4 },
        saveAgentConfiguration: { id: 'frozen-agent', revision: 7 },
      },
    });
    const service = createSaveMemoryService(repositories);

    expect(await service.processReadyJobs(async () => ({ memories: [{
      kind: 'episode', summary: 'A short new event.', detail: '', entities: [], salience: 0.5, confidence: 0.9,
    }] }))).toEqual({ completed: 1, failed: 0 });
    expect(repositories.memoryJobs.listByConversationId(conversation.id)).toContainEqual(expect.objectContaining({
      kind: 'consolidate', status: 'pending',
      payload: expect.objectContaining({
        provider: { id: 'frozen-provider', revision: 4 },
        saveAgentConfiguration: { id: 'frozen-agent', revision: 7 },
        sourceMemories: expect.arrayContaining([expect.objectContaining({ summary: 'The first long chapter.' })]),
      }),
    }));
  });
});
