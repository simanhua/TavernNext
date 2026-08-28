import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { GlobalEmbeddingConfiguration } from '@tavernnext/domain';
import type { Repositories } from '../db/repositories.js';
import type { MemoryDenseSearch } from './save-memory-service.js';

const EmbeddingResponseSchema = z.object({
  data: z.array(z.object({
    index: z.number().int().nonnegative(),
    embedding: z.array(z.number().finite()).min(1).max(65_536),
  }).strict()).min(1),
}).passthrough();

interface VectorCache {
  version: 1;
  fingerprint: string;
  entries: Record<string, number[]>;
}

function fingerprint(configuration: GlobalEmbeddingConfiguration): string {
  return createHash('sha256').update(JSON.stringify({
    baseUrl: configuration.baseUrl,
    model: configuration.model,
    dimensions: configuration.dimensions,
  })).digest('hex');
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += right[index]! ** 2;
  }
  return leftMagnitude === 0 || rightMagnitude === 0 ? 0 : dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function createOpenAICompatibleDenseSearch(options: {
  dataDir: string;
  repositories: Repositories;
  fetcher?: typeof fetch;
  resolveSecret: (secretRef: string, configuration: GlobalEmbeddingConfiguration) => string | undefined;
}): MemoryDenseSearch {
  const fetcher = options.fetcher ?? fetch;
  const root = resolve(options.dataDir, 'memory-index');
  const embed = async (configuration: GlobalEmbeddingConfiguration, texts: string[]): Promise<number[][]> => {
    if (configuration.baseUrl === null || configuration.model === null || configuration.secretRef === null) {
      throw new Error('embedding_not_configured');
    }
    const secret = options.resolveSecret(configuration.secretRef, configuration);
    if (secret === undefined) throw new Error('embedding_credential_unavailable');
    const response = await fetcher(`${configuration.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: configuration.model,
        input: texts,
        ...(configuration.dimensions === null ? {} : { dimensions: configuration.dimensions }),
      }),
    });
    if (!response.ok) throw new Error(`embedding_http_${response.status}`);
    const parsed = EmbeddingResponseSchema.parse(await response.json());
    const ordered = [...parsed.data].sort((left, right) => left.index - right.index).map((item) => item.embedding);
    if (ordered.length !== texts.length) throw new Error('embedding_response_mismatch');
    return ordered;
  };

  const search: MemoryDenseSearch = async (input) => {
    const configuration = options.repositories.globalEmbeddingConfiguration.get();
    if (!configuration.enabled) throw new Error('embedding_disabled');
    const cachePath = join(root, `${input.conversationId}.json`);
    const expectedFingerprint = fingerprint(configuration);
    let cache: VectorCache = { version: 1, fingerprint: expectedFingerprint, entries: {} };
    try {
      const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as VectorCache;
      if (parsed.version === 1 && parsed.fingerprint === expectedFingerprint && typeof parsed.entries === 'object') {
        cache = parsed;
      }
    } catch {
      // A missing or corrupt derived cache is rebuilt from authoritative Save Memory.
    }
    const missing = input.memories.filter((memory) => !Array.isArray(cache.entries[memory.contentHash]));
    const texts = [
      ...missing.map((memory) => `${memory.kind}\n${memory.summary}\n${memory.detail}`),
      input.query,
    ];
    const vectors = await embed(configuration, texts);
    missing.forEach((memory, index) => { cache.entries[memory.contentHash] = vectors[index]!; });
    const queryVector = vectors.at(-1)!;
    if (missing.length > 0) {
      await mkdir(root, { recursive: true });
      const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(cache)}\n`, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, cachePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    return new Map(input.memories.map((memory) => [
      memory.id,
      cosine(cache.entries[memory.contentHash] ?? [], queryVector),
    ]));
  };
  search.invalidate = async (conversationId) => {
    await rm(join(root, `${conversationId}.json`), { force: true });
  };
  search.rebuild = async (conversationId, memories) => {
    await search.invalidate!(conversationId);
    if (memories.length > 0) {
      await search({ conversationId, query: '', memories });
    }
  };
  return search;
}
