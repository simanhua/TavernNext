import { stream as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { ProviderError } from './errors.js';
import { agentToolCallCapability } from './provider-catalog.js';
import type { PiProviderProfile } from './types.js';

export interface PiAgentModelRuntime {
  model: Model<Api>;
  stream(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function customModel(profile: PiProviderProfile): Model<'openai-completions'> {
  const root = normalizeBaseUrl(profile.baseUrl);
  return {
    id: profile.modelId,
    name: profile.modelId,
    api: 'openai-completions',
    provider: 'custom-openai-compatible',
    baseUrl: root.endsWith('/v1') ? root : `${root}/v1`,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: { supportsFinishReason: false, maxTokensField: 'max_tokens' },
  };
}

function requestOptions(profile: PiProviderProfile, options?: SimpleStreamOptions): SimpleStreamOptions {
  return {
    ...options,
    apiKey: profile.apiKey,
    headers: { ...profile.headers, ...options?.headers },
    maxRetries: 0,
  };
}

export function createPiAgentModelRuntime(profile: PiProviderProfile): PiAgentModelRuntime {
  if (profile.providerId === 'custom-openai-compatible') {
    const model = customModel(profile);
    return {
      model,
      stream: (_model, context, options) => {
        const configured = requestOptions(profile, options);
        if (profile.apiKey === 'tavernnext-keyless-endpoint') {
          const upstreamFetch = options?.fetch ?? globalThis.fetch;
          configured.fetch = async (input, init) => {
            const headers = new Headers(init?.headers);
            headers.delete('authorization');
            return upstreamFetch(input, { ...init, headers });
          };
        }
        return streamOpenAICompletions(model, context, configured);
      },
    };
  }
  const models = builtinModels();
  const model = models.getModel(profile.providerId, profile.modelId);
  if (model === undefined || !agentToolCallCapability(model.api)) throw new ProviderError('protocol');
  if (normalizeBaseUrl(model.baseUrl) !== normalizeBaseUrl(profile.baseUrl)) throw new ProviderError('auth');
  return {
    model,
    stream: (_model, context, options) => models.streamSimple(
      model,
      context,
      requestOptions(profile, options),
    ),
  };
}
