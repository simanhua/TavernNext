import { join } from 'node:path';

import { TokenizerId } from './ids.js';
import { ModelCache, type ModelCacheLike, type TokenizerModelManifestEntry } from './model-cache.js';
import {
  isDownloadableWebTokenizer,
  modelTokenizerId,
  selectTokenizer,
  type TokenizerDecision,
} from './model-selection.js';
import { TOKENIZER_MODEL_MANIFEST } from './models.manifest.js';
import { getTokenizerRegistryEntry } from './registry.js';
import { RemoteTokenizerAdapter } from './remote-adapter.js';
import { SentencePieceAdapter, type SentencePieceProcessorLike } from './sentencepiece-adapter.js';
import { TiktokenAdapter, type TokenizerAdapter } from './tiktoken-adapter.js';
import { WebTokenizerAdapter, type WebTokenizerLike } from './web-tokenizer-adapter.js';

export * from './ids.js';
export * from './model-cache.js';
export * from './model-selection.js';
export * from './models.manifest.js';
export * from './registry.js';
export * from './remote-adapter.js';
export * from './sentencepiece-adapter.js';
export * from './tiktoken-adapter.js';
export * from './web-tokenizer-adapter.js';

export const BYTES_PER_TOKEN = 3.35;

export interface TokenizerMessage {
  readonly role: string;
  readonly content: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface TokenizerRuntimeOptions {
  readonly dataDir?: string;
  readonly fetch?: typeof fetch;
  readonly modelCache?: ModelCacheLike;
  readonly manifest?: Readonly<Partial<Record<TokenizerId, TokenizerModelManifestEntry>>>;
  readonly adapters?: Partial<Record<TokenizerId, TokenizerAdapter>>;
  readonly createSentencePieceProcessor?: () => SentencePieceProcessorLike;
  readonly loadWebTokenizer?: (modelPath: string) => Promise<WebTokenizerLike>;
  readonly downloadModel?: (url: string) => Promise<Uint8Array>;
}

type TokenizerReference = TokenizerId | TokenizerDecision;

const modelCaches = new Map<string, ModelCache>();
const adapterCache = new Map<string, TokenizerAdapter>();

function defaultDataDir(): string {
  return process.env.TAVERNNEXT_DATA_DIR || join(process.cwd(), '.tavernnext');
}

function asDecision(reference: TokenizerReference): TokenizerDecision {
  return typeof reference === 'number' ? selectTokenizer({ requestedId: reference }) : reference;
}

function estimation(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

function getModelCache(options: TokenizerRuntimeOptions): ModelCacheLike {
  if (options.modelCache) return options.modelCache;
  const dataDir = options.dataDir ?? defaultDataDir();
  if (options.downloadModel) return new ModelCache({ dataDir, download: options.downloadModel });
  let cache = modelCaches.get(dataDir);
  if (!cache) {
    cache = new ModelCache({ dataDir });
    modelCaches.set(dataDir, cache);
  }
  return cache;
}

function manifestEntry(id: TokenizerId, options: TokenizerRuntimeOptions): TokenizerModelManifestEntry {
  const entry = (options.manifest ?? TOKENIZER_MODEL_MANIFEST)[id];
  if (!entry) throw new Error(`Tokenizer ${getTokenizerRegistryEntry(id).name} has no model manifest entry`);
  return entry;
}

function uncachedAdapter(decision: TokenizerDecision, options: TokenizerRuntimeOptions): TokenizerAdapter {
  const id = decision.tokenizerId;
  const override = options.adapters?.[id];
  if (override) return override;

  if (id === TokenizerId.GPT2 || id === TokenizerId.OPENAI) {
    return new TiktokenAdapter(id === TokenizerId.GPT2 ? 'gpt2' : decision.tiktokenModel ?? 'gpt-3.5-turbo');
  }
  if (id === TokenizerId.API_KOBOLD || id === TokenizerId.API_TEXTGENERATIONWEBUI) {
    if (!decision.remoteEndpoint) throw new Error('Remote tokenizer requires an explicit tokenizer endpoint');
    return new RemoteTokenizerAdapter({
      tokenizerId: id,
      endpoint: decision.remoteEndpoint,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  const entry = manifestEntry(id, options);
  if (entry.format === 'sentencepiece') {
    return new SentencePieceAdapter({
      model: entry,
      cache: getModelCache(options),
      ...(options.createSentencePieceProcessor ? { createProcessor: options.createSentencePieceProcessor } : {}),
    });
  }
  return new WebTokenizerAdapter({
    model: entry,
    cache: getModelCache(options),
    ...(options.loadWebTokenizer ? { loadModel: options.loadWebTokenizer } : {}),
  });
}

function adapter(decision: TokenizerDecision, options: TokenizerRuntimeOptions): TokenizerAdapter {
  if (options.adapters || options.modelCache || options.manifest || options.createSentencePieceProcessor
    || options.loadWebTokenizer || options.downloadModel || options.fetch) {
    return uncachedAdapter(decision, options);
  }
  const dataDir = options.dataDir ?? defaultDataDir();
  const key = `${dataDir}\u0000${decision.tokenizerId}\u0000${decision.tiktokenModel ?? ''}\u0000${decision.remoteEndpoint ?? ''}`;
  let value = adapterCache.get(key);
  if (!value) {
    value = uncachedAdapter(decision, options);
    adapterCache.set(key, value);
  }
  return value;
}

function fallbackId(decision: TokenizerDecision, failedId: TokenizerId): TokenizerId {
  if (failedId === TokenizerId.API_KOBOLD || failedId === TokenizerId.API_TEXTGENERATIONWEBUI) {
    return decision.fallbackTokenizerId ?? modelTokenizerId(decision.model)
      ?? (decision.api === 'kobold' || decision.api === 'textgenerationwebui' ? TokenizerId.LLAMA : TokenizerId.NONE);
  }
  if (isDownloadableWebTokenizer(failedId)) return TokenizerId.LLAMA3;
  return TokenizerId.NONE;
}

function recordFallback(decision: TokenizerDecision, failedId: TokenizerId, replacementId: TokenizerId): void {
  decision.fallbackFrom ??= failedId;
  decision.fallbackTokenizerId = replacementId;
  decision.tokenizerId = replacementId;
  decision.tokenizerName = getTokenizerRegistryEntry(replacementId).name;
  if (failedId === TokenizerId.API_KOBOLD || failedId === TokenizerId.API_TEXTGENERATIONWEBUI) {
    decision.warning = `The remote tokenizer was unavailable or returned an invalid response; using ${getTokenizerRegistryEntry(replacementId).name}.`;
  } else if (replacementId === TokenizerId.LLAMA3) {
    decision.warning = `${getTokenizerRegistryEntry(failedId).name} model is unavailable; using Llama 3.`;
  } else {
    decision.warning = `${getTokenizerRegistryEntry(failedId).name} model is unavailable; using token estimation.`;
  }
}

async function execute<T>(
  decision: TokenizerDecision,
  options: TokenizerRuntimeOptions,
  operation: 'encode' | 'decode' | 'count',
  value: string | readonly number[],
): Promise<T> {
  const attempted = new Set<TokenizerId>();
  while (true) {
    const id = decision.tokenizerId;
    if (id === TokenizerId.NONE) {
      if (operation === 'count' && typeof value === 'string') return estimation(value) as T;
      throw new Error('The NONE / Estimated tokenizer cannot encode or decode token IDs');
    }
    if (id === TokenizerId.BEST_MATCH || id === TokenizerId.API_CURRENT) {
      throw new Error(`Unresolved tokenizer selector: ${id}`);
    }
    if (operation === 'decode' && (id === TokenizerId.API_KOBOLD || id === TokenizerId.API_TEXTGENERATIONWEBUI)) {
      throw new Error(`${getTokenizerRegistryEntry(id).name} cannot decode token IDs`);
    }

    try {
      const selectedAdapter = adapter(decision, options);
      if (operation === 'encode' && typeof value === 'string') return await selectedAdapter.encode(value) as T;
      if (operation === 'decode' && typeof value !== 'string') return await selectedAdapter.decode(value) as T;
      if (operation === 'count' && typeof value === 'string') {
        return (selectedAdapter.count ? await selectedAdapter.count(value) : (await selectedAdapter.encode(value)).length) as T;
      }
      throw new TypeError(`Invalid tokenizer ${operation} input`);
    } catch (error) {
      attempted.add(id);
      const replacement = fallbackId(decision, id);
      if (replacement === id || attempted.has(replacement)) throw error;
      recordFallback(decision, id, replacement);
    }
  }
}

function textArguments(
  first: string | TokenizerReference,
  second: string | TokenizerReference,
): { text: string; decision: TokenizerDecision } {
  return typeof first === 'string'
    ? { text: first, decision: asDecision(second as TokenizerReference) }
    : { text: second as string, decision: asDecision(first) };
}

export function countText(text: string, tokenizer: TokenizerReference, options?: TokenizerRuntimeOptions): Promise<number>;
export function countText(tokenizer: TokenizerReference, text: string, options?: TokenizerRuntimeOptions): Promise<number>;
export async function countText(
  first: string | TokenizerReference,
  second: string | TokenizerReference,
  options: TokenizerRuntimeOptions = {},
): Promise<number> {
  const { text, decision } = textArguments(first, second);
  return execute<number>(decision, options, 'count', text);
}

export function encodeText(text: string, tokenizer: TokenizerReference, options?: TokenizerRuntimeOptions): Promise<number[]>;
export function encodeText(tokenizer: TokenizerReference, text: string, options?: TokenizerRuntimeOptions): Promise<number[]>;
export async function encodeText(
  first: string | TokenizerReference,
  second: string | TokenizerReference,
  options: TokenizerRuntimeOptions = {},
): Promise<number[]> {
  const { text, decision } = textArguments(first, second);
  return execute<number[]>(decision, options, 'encode', text);
}

export function decodeTokens(ids: readonly number[], tokenizer: TokenizerReference, options?: TokenizerRuntimeOptions): Promise<string>;
export function decodeTokens(tokenizer: TokenizerReference, ids: readonly number[], options?: TokenizerRuntimeOptions): Promise<string>;
export async function decodeTokens(
  first: readonly number[] | TokenizerReference,
  second: readonly number[] | TokenizerReference,
  options: TokenizerRuntimeOptions = {},
): Promise<string> {
  const ids = Array.isArray(first) ? first : second as readonly number[];
  const decision = asDecision((Array.isArray(first) ? second : first) as TokenizerReference);
  return execute<string>(decision, options, 'decode', ids);
}

function flattenMessages(messages: readonly TokenizerMessage[]): string {
  return messages.flatMap((message) => Object.values(message)).join('\n\n');
}

function webTokenizerTranscript(messages: readonly TokenizerMessage[]): string {
  const copy = messages.map((message) => ({
    ...message,
    content: `${message.content || ''}${message.tool_calls ? JSON.stringify(message.tool_calls) : ''}`,
  }));
  if (!copy.length) return '';

  copy[0]!.role = 'system';
  let firstAssistant = -1;
  for (let index = 0; index < copy.length; index += 1) {
    const message = copy[index]!;
    if (message.role === 'assistant' && index > 0) {
      firstAssistant = index;
      break;
    }
  }
  copy[0]!.role = 'user';
  if (firstAssistant > 1 && copy[firstAssistant - 1]!.role === 'user') {
    copy[firstAssistant - 1]!.role = 'first-message';
  }

  return copy.map((message, index) => {
    const prefix = message.role === 'assistant' ? '\n\nAssistant: '
      : message.role === 'user' ? '\n\nHuman: '
        : message.role === 'first-message' ? '\n\nFirst message: '
          : message.role === 'system' ? (index === 0 ? ''
            : message.name === 'example_assistant' ? '\n\nA: '
              : message.name === 'example_user' ? '\n\nH: ' : '\n\n') : '';
    const name = message.name && message.role !== 'system' ? `${message.name}: ` : '';
    return `${prefix}${name}${message.content}`;
  }).join('');
}

async function countOpenAiMessages(
  messages: readonly TokenizerMessage[],
  decision: TokenizerDecision,
  options: TokenizerRuntimeOptions,
): Promise<number> {
  const framingModel = decision.model ?? decision.tiktokenModel ?? '';
  const tokensPerMessage = framingModel.includes('gpt-3.5-turbo-0301') ? 4 : 3;
  const tokensPerName = framingModel.includes('gpt-3.5-turbo-0301') ? -1 : 1;
  let count = 3;
  for (const message of messages) {
    count += tokensPerMessage;
    for (const [key, value] of Object.entries(message)) {
      if (typeof value !== 'string') continue;
      count += await countText(value, decision, options);
      if (key === 'name') count += tokensPerName;
    }
  }
  if (framingModel.includes('gpt-3.5-turbo-0301')) count += 9;
  return count;
}

export function countMessages(messages: readonly TokenizerMessage[], tokenizer: TokenizerReference, options?: TokenizerRuntimeOptions): Promise<number>;
export function countMessages(tokenizer: TokenizerReference, messages: readonly TokenizerMessage[], options?: TokenizerRuntimeOptions): Promise<number>;
export async function countMessages(
  first: readonly TokenizerMessage[] | TokenizerReference,
  second: readonly TokenizerMessage[] | TokenizerReference,
  options: TokenizerRuntimeOptions = {},
): Promise<number> {
  const messages = Array.isArray(first) ? first as readonly TokenizerMessage[] : second as readonly TokenizerMessage[];
  const decision = asDecision((Array.isArray(first) ? second : first) as TokenizerReference);
  if (decision.tokenizerId === TokenizerId.OPENAI) return countOpenAiMessages(messages, decision, options);

  const kind = getTokenizerRegistryEntry(decision.tokenizerId).kind;
  const text = kind === 'web-tokenizer' ? webTokenizerTranscript(messages) : flattenMessages(messages);
  return countText(text, decision, options);
}
