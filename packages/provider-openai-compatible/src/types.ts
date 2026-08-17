import type { ProviderProfile } from '@tavernnext/domain';

export type ProviderErrorCode = 'auth' | 'connection' | 'rate_limit' | 'protocol' | 'context_overflow' | 'aborted';

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string | readonly string[];
}

export interface TextRequest {
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string | readonly string[];
}

export type ProviderEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed'; finishReason: string };

/**
 * Resolved only on the server, immediately before the provider is called.
 * API keys and custom headers must never be persisted in a domain profile.
 */
export type OpenAICompatibleProfile = Pick<ProviderProfile, 'baseUrl'> & {
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
};

export interface OpenAICompatibleClient {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  streamText(request: TextRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}
