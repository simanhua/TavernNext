import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api } from '@earendil-works/pi-ai';

export interface PiProviderCatalogEntry {
  id: string;
  name: string;
  authentication: 'api_key' | 'oauth' | 'subscription' | 'composite';
  available: boolean;
  customBaseUrl: boolean;
  baseUrl?: string;
  credentialLabel?: string;
  unavailableReason?: string;
  models: Array<{ id: string; name: string; baseUrl: string; toolCalls: boolean }>;
}

const compositeProviders = new Set([
  'amazon-bedrock',
  'azure-openai-responses',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'google-vertex',
]);

const toolCallApis = new Set<Api>([
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
]);

export function agentToolCallCapability(api: Api): boolean {
  return toolCallApis.has(api);
}

export function piProviderCatalog(): PiProviderCatalogEntry[] {
  const models = builtinModels();
  const entries = models.getProviders().map((provider): PiProviderCatalogEntry => {
    const apiKey = provider.auth.apiKey;
    const composite = compositeProviders.has(provider.id);
    const oauthOnly = apiKey === undefined;
    const subscription = oauthOnly && provider.auth.oauth?.isSubscription === true;
    const available = apiKey !== undefined && !composite;
    return {
      id: provider.id,
      name: provider.name,
      authentication: composite ? 'composite' : subscription ? 'subscription' : oauthOnly ? 'oauth' : 'api_key',
      available,
      customBaseUrl: false,
      ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
      ...(available ? { credentialLabel: apiKey.name } : {
        unavailableReason: composite
          ? 'This Provider needs composite cloud credentials that TavernNext does not support yet.'
          : subscription
            ? 'Subscription login is not supported yet.'
            : 'OAuth login is not supported yet.',
      }),
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        baseUrl: model.baseUrl,
        toolCalls: agentToolCallCapability(model.api),
      })),
    };
  });
  entries.push({
    id: 'custom-openai-compatible',
    name: 'Custom OpenAI-compatible',
    authentication: 'api_key',
    available: true,
    customBaseUrl: true,
    credentialLabel: 'API key',
    models: [],
  });
  return entries;
}
