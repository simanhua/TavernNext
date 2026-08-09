import { SentencePieceProcessor } from '@agnai/sentencepiece-js';

import type { ModelCacheLike, TokenizerModelManifestEntry } from './model-cache.js';
import type { TokenizerAdapter } from './tiktoken-adapter.js';

export interface SentencePieceProcessorLike {
  load(modelPath: string): Promise<void>;
  encodeIds(text: string): number[];
  decodeIds(ids: number[]): string;
}

export interface SentencePieceAdapterOptions {
  readonly model: TokenizerModelManifestEntry;
  readonly cache: ModelCacheLike;
  readonly createProcessor?: () => SentencePieceProcessorLike;
}

export class SentencePieceAdapter implements TokenizerAdapter {
  readonly #model: TokenizerModelManifestEntry;
  readonly #cache: ModelCacheLike;
  readonly #createProcessor: () => SentencePieceProcessorLike;
  #processor?: Promise<SentencePieceProcessorLike>;

  constructor(options: SentencePieceAdapterOptions) {
    this.#model = options.model;
    this.#cache = options.cache;
    this.#createProcessor = options.createProcessor ?? (() => new SentencePieceProcessor());
  }

  async #get(): Promise<SentencePieceProcessorLike> {
    this.#processor ??= (async () => {
      const modelPath = await this.#cache.ensure(this.#model);
      const processor = this.#createProcessor();
      await processor.load(modelPath);
      return processor;
    })();
    return this.#processor;
  }

  async encode(text: string): Promise<number[]> {
    return Array.from((await this.#get()).encodeIds(text));
  }

  async decode(ids: readonly number[]): Promise<string> {
    const processor = await this.#get();
    return ids.map((id) => processor.decodeIds([id])).join('');
  }

  async count(text: string): Promise<number> {
    return (await this.#get()).encodeIds(text).length;
  }
}
