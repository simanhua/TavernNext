import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { createOpenAICompatibleDenseSearch } from '../src/services/memory-embedding.js';
import { TEST_REPOSITORY_OPTIONS } from './test-integrity-key.js';
import { SaveMemorySchema } from '@tavernnext/domain';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('OpenAI-compatible Memory embeddings', () => {
  it('caches Memory vectors per Save and embeds only the query on a cache hit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-memory-embedding-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    expect(repositories.globalEmbeddingConfiguration.update(0, {
      enabled: true, baseUrl: 'http://embedding.test/v1', model: 'embed-test',
      secretRef: 'embedding-secret', dimensions: 2,
    }).ok).toBe(true);
    const conversationId = '018f0000-0000-7000-8000-000000000901';
    const memory = (summary: string, hash: string) => SaveMemorySchema.parse({
      id: randomUUID(), revision: 0, createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      conversationId, kind: 'episode', tier: 'near', summary, detail: '',
      entities: [], salience: 0.5, confidence: 0.8,
      sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
      sourceMemoryIds: [], supersedesId: null, contentHash: hash.repeat(64), tokenCount: 4,
    });
    // The dense Adapter only needs immutable memory identity/content; repository FK ownership is covered elsewhere.
    const promise = memory('promise to return', 'a');
    const vault = memory('vault beneath clock', 'b');
    const requests: string[][] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-value');
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      requests.push(body.input);
      return new Response(JSON.stringify({ data: body.input.map((text, index) => ({
        index,
        embedding: text.includes('vault') ? [0, 1] : [1, 0],
      })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const dense = createOpenAICompatibleDenseSearch({
      dataDir: directory,
      repositories,
      fetcher,
      resolveSecret: () => 'secret-value',
    });

    const input = { conversationId: promise.conversationId, query: 'return promise', memories: [promise, vault] };
    expect([...await dense(input)]).toEqual([[promise.id, 1], [vault.id, 0]]);
    expect([...await dense(input)]).toEqual([[promise.id, 1], [vault.id, 0]]);
    await dense({ ...input, memories: [promise] });
    expect([...await dense(input)]).toEqual([[promise.id, 1], [vault.id, 0]]);
    await dense.invalidate?.(conversationId);
    expect([...await dense(input)]).toEqual([[promise.id, 1], [vault.id, 0]]);
    expect(dense.rebuild).toBeTypeOf('function');
    await dense.rebuild!(conversationId, [promise]);
    expect([...await dense(input)]).toEqual([[promise.id, 1], [vault.id, 0]]);
    expect(dense.searchSave).toBeTypeOf('function');
    expect([...(await dense.searchSave!({ ...input, memories: [promise] })).keys()]).toContain(vault.id);
    expect(requests.map((items) => items.length)).toEqual([2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1]);

    requests.length = 0;
    const many = Array.from({ length: 130 }, (_, index) => SaveMemorySchema.parse({
      ...promise,
      id: randomUUID(),
      summary: `Memory ${index}`,
      contentHash: index.toString(16).padStart(64, '0'),
    }));
    await dense.rebuild!(conversationId, many);
    expect(Math.max(...requests.map((items) => items.length))).toBeLessThanOrEqual(64);
  });
});
