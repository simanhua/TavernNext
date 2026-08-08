import tiktoken, { type Tiktoken, type TiktokenModel } from 'tiktoken';

export interface TokenizerAdapter {
  encode(text: string): Promise<number[]>;
  decode(ids: readonly number[]): Promise<string>;
  count?(text: string): Promise<number>;
}

const encodings = new Map<string, Tiktoken>();

function encoding(model: string): Tiktoken {
  const cached = encodings.get(model);
  if (cached) return cached;

  const loaded = model === 'gpt2'
    ? tiktoken.get_encoding('gpt2')
    : tiktoken.encoding_for_model(model as TiktokenModel);
  encodings.set(model, loaded);
  return loaded;
}

export class TiktokenAdapter implements TokenizerAdapter {
  readonly #model: string;

  constructor(model: string) {
    this.#model = model;
  }

  async encode(text: string): Promise<number[]> {
    return Array.from(encoding(this.#model).encode(text));
  }

  async decode(ids: readonly number[]): Promise<string> {
    const bytes = encoding(this.#model).decode(Uint32Array.from(ids));
    return new TextDecoder().decode(bytes);
  }

  async count(text: string): Promise<number> {
    return encoding(this.#model).encode(text).length;
  }
}
