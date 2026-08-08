import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ModelCache,
  TokenizerId,
  countMessages,
  countText,
  decodeTokens,
  encodeText,
  selectTokenizer,
  type ModelCacheIo,
  type TokenizerModelManifestEntry,
} from '../src/index.js';
import parityCorpus from '../../../tests/fixtures/tokenizers/parity-corpus.json' with { type: 'json' };

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-tokenizers-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('static tokenizer parity corpus', () => {
  it.each(parityCorpus)('$caseName matches the SillyTavern 1.18.0 oracle', async (fixture) => {
    const runtime = { dataDir: await temporaryDirectory() };
    const decision = selectTokenizer({
      requestedId: fixture.tokenizerId,
      model: fixture.model,
    });
    const ids = await encodeText(fixture.input, decision, runtime);

    expect(ids).toEqual(fixture.encodedIds);
    expect(await decodeTokens(ids, decision, runtime)).toBe(fixture.decodedText);
    expect(await countText(fixture.input, decision, runtime)).toBe(fixture.count);
  });
});

describe('estimation and message counting', () => {
  it('uses ceil(UTF-8 bytes / 3.35) for NONE and refuses to invent token IDs', async () => {
    const decision = selectTokenizer({ requestedId: TokenizerId.NONE });

    await expect(countText('你好🙂', decision)).resolves.toBe(3);
    await expect(encodeText('你好🙂', decision)).rejects.toThrow(/cannot encode/i);
  });

  it('uses OpenAI chat framing overhead for message counts', async () => {
    const decision = selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'gpt-3.5-turbo',
    });

    await expect(countMessages([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hello' },
    ], decision)).resolves.toBe(16);
  });

  it('uses the configured runtime adapter while counting OpenAI messages', async () => {
    const decision = selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'gpt-3.5-turbo',
    });

    await expect(countMessages([{ role: 'user', content: 'x' }], decision, {
      adapters: {
        [TokenizerId.OPENAI]: {
          encode: async (text) => Array.from({ length: text.length }, (_, index) => index),
          decode: async () => '',
          count: async (text) => text.length,
        },
      },
    })).resolves.toBe(11);
  });

  it('uses the baseline Claude transcript conversion for web-tokenizer message counts', async () => {
    const decision = selectTokenizer({ requestedId: TokenizerId.CLAUDE });
    const count = vi.fn(async (text: string) => text.length);

    await countMessages([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'context' },
      { role: 'user', content: 'last' },
      { role: 'assistant', content: 'reply' },
    ], decision, {
      adapters: {
        [TokenizerId.CLAUDE]: {
          encode: async () => [],
          decode: async () => '',
          count,
        },
      },
    });

    expect(count).toHaveBeenCalledWith('\n\nHuman: rules\n\nHuman: context\n\nFirst message: last\n\nAssistant: reply');
  });

  it('flattens every message value for sentencepiece counting like the baseline', async () => {
    const decision = selectTokenizer({ requestedId: TokenizerId.LLAMA });
    const count = vi.fn(async (text: string) => text.length);

    await countMessages([{ role: 'user', content: 'hello', weight: 2 }], decision, {
      adapters: {
        [TokenizerId.LLAMA]: {
          encode: async () => [],
          decode: async () => '',
          count,
        },
      },
    });

    expect(count).toHaveBeenCalledWith('user\n\nhello\n\n2');
  });
});

describe('model cache', () => {
  it('downloads to a temporary file, verifies SHA-256, and atomically renames into dataDir/tokenizers', async () => {
    const data = new TextEncoder().encode('{"model":"fixture"}');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const dataDir = await temporaryDirectory();
    const renameCalls: Parameters<ModelCacheIo['rename']>[] = [];
    const renameModel: ModelCacheIo['rename'] = async (from, to) => {
      const { rename: realRename } = await import('node:fs/promises');
      renameCalls.push([from, to]);
      await realRename(from, to);
    };
    const cache = new ModelCache({
      dataDir,
      download: vi.fn(async () => data),
      io: { rename: renameModel },
    });
    const entry: TokenizerModelManifestEntry = {
      tokenizerId: TokenizerId.QWEN2,
      fileName: 'fixture.json',
      format: 'web-tokenizer',
      url: 'https://models.invalid/fixture.json',
      sha256,
      fallbackTokenizerId: TokenizerId.LLAMA3,
    };

    const modelPath = await cache.ensure(entry);

    expect(modelPath).toBe(join(dataDir, 'tokenizers', 'fixture.json'));
    expect(await readFile(modelPath)).toEqual(Buffer.from(data));
    expect(renameCalls).toHaveLength(1);
    expect(String(renameCalls[0]?.[0])).toMatch(/\.tmp$/);
    await expect(stat(String(renameCalls[0]?.[0] ?? ''))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves no target file when a downloaded model hash is invalid', async () => {
    const dataDir = await temporaryDirectory();
    const cache = new ModelCache({
      dataDir,
      download: async () => new TextEncoder().encode('tampered'),
    });
    const entry: TokenizerModelManifestEntry = {
      tokenizerId: TokenizerId.QWEN2,
      fileName: 'fixture.json',
      format: 'web-tokenizer',
      url: 'https://models.invalid/fixture.json',
      sha256: '0'.repeat(64),
      fallbackTokenizerId: TokenizerId.LLAMA3,
    };

    await expect(cache.ensure(entry)).rejects.toThrow(/SHA-256/i);
    await expect(stat(join(dataDir, 'tokenizers', 'fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a corrupt cached model only after validating its replacement', async () => {
    const data = new TextEncoder().encode('{"model":"replacement"}');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const dataDir = await temporaryDirectory();
    const target = join(dataDir, 'tokenizers', 'fixture.json');
    await mkdir(join(dataDir, 'tokenizers'), { recursive: true });
    await writeFile(target, 'corrupt');
    const cache = new ModelCache({ dataDir, download: async () => data });
    const entry: TokenizerModelManifestEntry = {
      tokenizerId: TokenizerId.QWEN2,
      fileName: 'fixture.json',
      format: 'web-tokenizer',
      url: 'https://models.invalid/fixture.json',
      sha256,
      fallbackTokenizerId: TokenizerId.LLAMA3,
    };

    await expect(cache.ensure(entry)).resolves.toBe(target);
    await expect(readFile(target)).resolves.toEqual(Buffer.from(data));
  });
});

describe('remote and model fallback behavior', () => {
  it('posts only to the explicit tokenizer endpoint and accepts a valid remote response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ count: 2, ids: [101, 102] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const decision = selectTokenizer({
      requestedId: TokenizerId.API_KOBOLD,
      api: 'kobold',
      remoteEndpoint: 'http://127.0.0.1:5001/extra/tokencount',
    });

    await expect(encodeText('hello', decision, { fetch })).resolves.toEqual([101, 102]);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5001/extra/tokencount',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not claim that a count-only remote tokenizer can decode token IDs', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ count: 1, ids: [101] }), { status: 200 }));
    const decision = selectTokenizer({
      requestedId: TokenizerId.API_KOBOLD,
      api: 'kobold',
      remoteEndpoint: 'http://127.0.0.1:5001/extra/tokencount',
    });

    await expect(decodeTokens([101], decision, { fetch })).rejects.toThrow(/cannot decode/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(decision.tokenizerId).toBe(TokenizerId.API_KOBOLD);
  });

  it('warns and uses the matching local tokenizer after an invalid remote response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ids: 'not-an-array' }), { status: 200 }));
    const localIds = [123, 456];
    const decision = selectTokenizer({
      requestedId: TokenizerId.API_TEXTGENERATIONWEBUI,
      api: 'textgenerationwebui',
      model: 'llama-3.1',
      remoteEndpoint: 'http://127.0.0.1:5001/tokenize',
    });

    await expect(encodeText('hello', decision, {
      fetch,
      adapters: {
        [TokenizerId.LLAMA3]: {
          encode: async () => localIds,
          decode: async () => 'hello',
        },
      },
    })).resolves.toEqual(localIds);
    expect(decision).toMatchObject({
      tokenizerId: TokenizerId.LLAMA3,
      fallbackFrom: TokenizerId.API_TEXTGENERATIONWEBUI,
      warning: expect.stringContaining('remote tokenizer'),
    });
  });

  it('uses Llama 3 and records a warning when a downloadable web model load fails', async () => {
    const decision = selectTokenizer({ requestedId: TokenizerId.QWEN2, model: 'qwen2.5' });

    await expect(encodeText('hello', decision, {
      adapters: {
        [TokenizerId.QWEN2]: {
          encode: async () => { throw new Error('model unavailable'); },
          decode: async () => { throw new Error('model unavailable'); },
        },
        [TokenizerId.LLAMA3]: {
          encode: async () => [42],
          decode: async () => 'hello',
        },
      },
    })).resolves.toEqual([42]);
    expect(decision).toMatchObject({
      tokenizerId: TokenizerId.LLAMA3,
      fallbackFrom: TokenizerId.QWEN2,
      warning: expect.stringContaining('Llama 3'),
    });
  });

  it.each([
    TokenizerId.QWEN2,
    TokenizerId.COMMAND_R,
    TokenizerId.COMMAND_A,
    TokenizerId.NEMO,
    TokenizerId.DEEPSEEK,
  ])('deterministically falls back tokenizer %s to bundled Llama 3 without network', async (tokenizerId) => {
    const dataDir = await temporaryDirectory();
    const decision = selectTokenizer({ requestedId: tokenizerId });
    const fetch = vi.fn(async () => { throw new Error('network must not be used'); });

    await expect(encodeText('A dragon appears 🐉✨', decision, { dataDir, fetch })).resolves.toEqual([
      32, 26161, 8111, 11410, 238, 231, 38798, 101,
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      tokenizerId: TokenizerId.LLAMA3,
      fallbackFrom: tokenizerId,
      warning: expect.stringContaining('Llama 3'),
    });
  });
});
