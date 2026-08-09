import { readFile } from 'node:fs/promises';

import { Tokenizer } from '@agnai/web-tokenizers';

import type { ModelCacheLike, TokenizerModelManifestEntry } from './model-cache.js';
import type { TokenizerAdapter } from './tiktoken-adapter.js';

export interface WebTokenizerLike {
  encode(text: string): Int32Array;
  decode(ids: Int32Array): string;
}

export interface WebTokenizerAdapterOptions {
  readonly model: TokenizerModelManifestEntry;
  readonly cache: ModelCacheLike;
  readonly loadModel?: (modelPath: string) => Promise<WebTokenizerLike>;
}

async function loadWebTokenizer(modelPath: string): Promise<WebTokenizerLike> {
  const bytes = await readFile(modelPath);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return Tokenizer.fromJSON(arrayBuffer);
}

export class WebTokenizerAdapter implements TokenizerAdapter {
  readonly #model: TokenizerModelManifestEntry;
  readonly #cache: ModelCacheLike;
  readonly #loadModel: (modelPath: string) => Promise<WebTokenizerLike>;
  #tokenizer?: Promise<WebTokenizerLike>;

  constructor(options: WebTokenizerAdapterOptions) {
    this.#model = options.model;
    this.#cache = options.cache;
    this.#loadModel = options.loadModel ?? loadWebTokenizer;
  }

  async #get(): Promise<WebTokenizerLike> {
    this.#tokenizer ??= this.#cache.ensure(this.#model).then(this.#loadModel);
    return this.#tokenizer;
  }

  async encode(text: string): Promise<number[]> {
    return Array.from((await this.#get()).encode(text));
  }

  async decode(ids: readonly number[]): Promise<string> {
    return (await this.#get()).decode(Int32Array.from(ids));
  }

  async count(text: string): Promise<number> {
    return (await this.#get()).encode(text).length;
  }
}
