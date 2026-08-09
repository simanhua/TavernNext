import { TokenizerId } from './ids.js';
import { getTokenizerRegistryEntry } from './registry.js';

export interface TokenizerSelectionInput {
  readonly requestedId: TokenizerId;
  readonly api?: string;
  readonly model?: string;
  readonly remoteEndpoint?: string;
  readonly unavailableTokenizerIds?: readonly TokenizerId[];
}

export interface TokenizerDecision {
  readonly requestedId: TokenizerId;
  tokenizerId: TokenizerId;
  tokenizerName: string;
  readonly api?: string;
  readonly model?: string;
  readonly remoteEndpoint?: string;
  readonly tiktokenModel?: string;
  fallbackTokenizerId?: TokenizerId;
  fallbackFrom?: TokenizerId;
  warning?: string;
}

const DOWNLOADABLE_WEB_TOKENIZERS = new Set<TokenizerId>([
  TokenizerId.QWEN2,
  TokenizerId.COMMAND_R,
  TokenizerId.COMMAND_A,
  TokenizerId.NEMO,
  TokenizerId.DEEPSEEK,
]);

const TEXT_COMPLETION_MODELS = new Set([
  'gpt-3.5-turbo-instruct',
  'gpt-3.5-turbo-instruct-0914',
  'text-davinci-003',
  'text-davinci-002',
  'text-davinci-001',
  'text-curie-001',
  'text-babbage-001',
  'text-ada-001',
  'code-davinci-002',
  'code-davinci-001',
  'code-cushman-002',
  'code-cushman-001',
  'text-davinci-edit-001',
  'code-davinci-edit-001',
  'text-embedding-ada-002',
  'text-similarity-davinci-001',
  'text-similarity-curie-001',
  'text-similarity-babbage-001',
  'text-similarity-ada-001',
  'text-search-davinci-doc-001',
  'text-search-curie-doc-001',
  'text-search-babbage-doc-001',
  'text-search-ada-doc-001',
  'code-search-babbage-code-001',
  'code-search-ada-code-001',
]);

function validRemoteEndpoint(endpoint: string | undefined): endpoint is string {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openAiChatTokenizerId(modelName: string | undefined): TokenizerId | undefined {
  const model = String(modelName ?? '').toLowerCase();
  if (!model) return undefined;

  if (model.includes('claude')) return TokenizerId.CLAUDE;
  if (model.includes('llama3') || model.includes('llama-3')) return TokenizerId.LLAMA3;
  if (model.includes('llama')) return TokenizerId.LLAMA;
  if (model.includes('mistral') || model.includes('mixtral')) return TokenizerId.MISTRAL;
  if (model.includes('yi')) return TokenizerId.YI;
  if (model.includes('deepseek')) return TokenizerId.DEEPSEEK;
  if (model.includes('gemma') || model.includes('gemini') || model.includes('learnlm')) return TokenizerId.GEMMA;
  if (model.includes('jamba')) return TokenizerId.JAMBA;
  if (model.includes('qwen2')) return TokenizerId.QWEN2;
  if (model.includes('command-r')) return TokenizerId.COMMAND_R;
  if (model.includes('command-a')) return TokenizerId.COMMAND_A;
  if (model.includes('nemo')) return TokenizerId.NEMO;
  return undefined;
}

export const modelTokenizerId = openAiChatTokenizerId;

export function textGenerationTokenizerId(modelName: string | undefined): TokenizerId {
  const model = String(modelName ?? '').toLowerCase();
  if (model.includes('llama3') || model.includes('llama-3')) return TokenizerId.LLAMA3;
  if (model.includes('mistral') || model.includes('mixtral')) return TokenizerId.MISTRAL;
  if (model.includes('gemma')) return TokenizerId.GEMMA;
  if (model.includes('nemo') || model.includes('pixtral')) return TokenizerId.NEMO;
  if (model.includes('deepseek')) return TokenizerId.DEEPSEEK;
  if (model.includes('yi')) return TokenizerId.YI;
  if (model.includes('jamba')) return TokenizerId.JAMBA;
  if (model.includes('command-r')) return TokenizerId.COMMAND_R;
  if (model.includes('command-a')) return TokenizerId.COMMAND_A;
  if (model.includes('qwen2')) return TokenizerId.QWEN2;
  return TokenizerId.LLAMA;
}

export function tiktokenModelName(modelName: string | undefined): string {
  const model = String(modelName ?? '');
  if (model === 'o1' || model.includes('o1-preview') || model.includes('o1-mini') || model.includes('o3-mini')) return 'o1';
  if (model.includes('gpt-5') || model.includes('o3') || model.includes('o4-mini')) return 'o1';
  if (model.includes('gpt-4o') || model.includes('chatgpt-4o-latest') || model.includes('gpt-4.1') || model.includes('gpt-4.5')) return 'gpt-4o';
  if (model.includes('gpt-4-32k')) return 'gpt-4-32k';
  if (model.includes('gpt-4')) return 'gpt-4';
  if (model.includes('gpt-3.5-turbo-0301')) return 'gpt-3.5-turbo-0301';
  if (model.includes('gpt-3.5-turbo')) return 'gpt-3.5-turbo';
  if (TEXT_COMPLETION_MODELS.has(model)) return model;
  if (model === 'gpt2') return 'gpt2';
  return 'gpt-3.5-turbo';
}

function localBestMatch(input: TokenizerSelectionInput): TokenizerId {
  const model = String(input.model ?? '').toLowerCase();
  if (input.api === 'novel') {
    if (model.includes('clio')) return TokenizerId.NERD;
    if (model.includes('kayra')) return TokenizerId.NERD2;
    if (model.includes('erato')) return TokenizerId.LLAMA3;
    return TokenizerId.NONE;
  }

  if (input.api === 'textgenerationwebui') return textGenerationTokenizerId(model);
  if (input.api === 'kobold' || input.api === 'koboldhorde') return TokenizerId.LLAMA;
  if (input.api === 'openai') return openAiChatTokenizerId(model) ?? TokenizerId.OPENAI;
  return TokenizerId.NONE;
}

export function remoteFallbackTokenizerId(
  remoteId: TokenizerId.API_KOBOLD | TokenizerId.API_TEXTGENERATIONWEBUI,
  modelName: string | undefined,
): TokenizerId {
  return remoteId === TokenizerId.API_KOBOLD ? TokenizerId.LLAMA : textGenerationTokenizerId(modelName);
}

function remoteMode(api: string | undefined): TokenizerId | undefined {
  if (api === 'kobold') return TokenizerId.API_KOBOLD;
  if (api === 'textgenerationwebui') return TokenizerId.API_TEXTGENERATIONWEBUI;
  return undefined;
}

function decision(input: TokenizerSelectionInput, tokenizerId: TokenizerId): TokenizerDecision {
  return {
    requestedId: input.requestedId,
    tokenizerId,
    tokenizerName: getTokenizerRegistryEntry(tokenizerId).name,
    ...(input.api ? { api: input.api } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(validRemoteEndpoint(input.remoteEndpoint) ? { remoteEndpoint: input.remoteEndpoint } : {}),
    ...(tokenizerId === TokenizerId.OPENAI || tokenizerId === TokenizerId.GPT2
      ? { tiktokenModel: tokenizerId === TokenizerId.GPT2 ? 'gpt2' : tiktokenModelName(input.model) }
      : {}),
  };
}

function withFallback(result: TokenizerDecision, fallbackFrom: TokenizerId, fallbackId: TokenizerId, warning: string): TokenizerDecision {
  result.tokenizerId = fallbackId;
  result.tokenizerName = getTokenizerRegistryEntry(fallbackId).name;
  result.fallbackFrom = fallbackFrom;
  result.fallbackTokenizerId = fallbackId;
  result.warning = warning;
  return result;
}

export function selectTokenizer(input: TokenizerSelectionInput): TokenizerDecision {
  let selected = input.requestedId;

  if (selected === TokenizerId.BEST_MATCH) {
    const remote = remoteMode(input.api);
    selected = remote !== undefined && validRemoteEndpoint(input.remoteEndpoint)
      ? remote
      : localBestMatch(input);
  } else if (selected === TokenizerId.API_CURRENT) {
    selected = remoteMode(input.api) ?? localBestMatch(input);
  } else if (selected === TokenizerId.OPENAI) {
    selected = openAiChatTokenizerId(input.model) ?? TokenizerId.OPENAI;
  }

  const result = decision(input, selected);

  if ([TokenizerId.API_CURRENT, TokenizerId.API_KOBOLD, TokenizerId.API_TEXTGENERATIONWEBUI].includes(input.requestedId)
    && (!validRemoteEndpoint(input.remoteEndpoint) || ![TokenizerId.API_KOBOLD, TokenizerId.API_TEXTGENERATIONWEBUI].includes(selected))) {
    const fallbackId = input.requestedId === TokenizerId.API_KOBOLD
      ? remoteFallbackTokenizerId(TokenizerId.API_KOBOLD, input.model)
      : input.requestedId === TokenizerId.API_TEXTGENERATIONWEBUI
        ? remoteFallbackTokenizerId(TokenizerId.API_TEXTGENERATIONWEBUI, input.model)
        : localBestMatch(input);
    return withFallback(
      result,
      input.requestedId,
      fallbackId,
      `The requested remote tokenizer has no valid explicit tokenizer endpoint; using ${getTokenizerRegistryEntry(fallbackId).name}.`,
    );
  }

  if (input.unavailableTokenizerIds?.includes(selected)) {
    const fallbackId = DOWNLOADABLE_WEB_TOKENIZERS.has(selected) ? TokenizerId.LLAMA3 : TokenizerId.NONE;
    return withFallback(
      result,
      selected,
      fallbackId,
      DOWNLOADABLE_WEB_TOKENIZERS.has(selected)
        ? `${getTokenizerRegistryEntry(selected).name} model is unavailable; using Llama 3.`
        : `${getTokenizerRegistryEntry(selected).name} model is unavailable; using token estimation.`,
    );
  }

  if ([TokenizerId.API_KOBOLD, TokenizerId.API_TEXTGENERATIONWEBUI].includes(selected)) {
    result.fallbackTokenizerId = remoteFallbackTokenizerId(
      selected as TokenizerId.API_KOBOLD | TokenizerId.API_TEXTGENERATIONWEBUI,
      input.model,
    );
  }
  return result;
}

export function isDownloadableWebTokenizer(id: TokenizerId): boolean {
  return DOWNLOADABLE_WEB_TOKENIZERS.has(id);
}
