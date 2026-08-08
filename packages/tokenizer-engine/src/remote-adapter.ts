import { TokenizerId } from './ids.js';
import type { TokenizerAdapter } from './tiktoken-adapter.js';

interface RemoteTokenizationResponse {
  readonly count: number;
  readonly ids?: number[];
}

export interface RemoteTokenizerAdapterOptions {
  readonly tokenizerId: TokenizerId.API_KOBOLD | TokenizerId.API_TEXTGENERATIONWEBUI;
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
}

function integerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item) && item >= 0)) return undefined;
  return value as number[];
}

function parseResponse(value: unknown): RemoteTokenizationResponse {
  if (!value || typeof value !== 'object') throw new Error('Remote tokenizer returned an invalid response');
  const body = value as Record<string, unknown>;
  const ids = integerArray(body.ids) ?? integerArray(body.tokens);
  const countCandidate = body.count ?? body.value ?? body.length ?? ids?.length;
  const count = typeof countCandidate === 'number' ? countCandidate : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Remote tokenizer returned an invalid token count');
  }
  return { count, ...(ids ? { ids } : {}) };
}

export class RemoteTokenizerAdapter implements TokenizerAdapter {
  readonly #tokenizerId: TokenizerId.API_KOBOLD | TokenizerId.API_TEXTGENERATIONWEBUI;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteTokenizerAdapterOptions) {
    this.#tokenizerId = options.tokenizerId;
    this.#endpoint = options.endpoint;
    this.#fetch = options.fetch ?? fetch;
  }

  async #tokenize(text: string): Promise<RemoteTokenizationResponse> {
    const body = this.#tokenizerId === TokenizerId.API_KOBOLD ? { prompt: text } : { text };
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Remote tokenizer failed with HTTP ${response.status}`);
    return parseResponse(await response.json());
  }

  async encode(text: string): Promise<number[]> {
    const response = await this.#tokenize(text);
    if (!response.ids) throw new Error('Remote tokenizer response did not include token IDs');
    return response.ids;
  }

  async decode(_ids: readonly number[]): Promise<string> {
    throw new Error('Remote tokenizer cannot decode token IDs');
  }

  async count(text: string): Promise<number> {
    return (await this.#tokenize(text)).count;
  }
}
