import { ProviderError } from './errors.js';
import type { ModelInfo, OpenAICompatibleClient, OpenAICompatibleProfile } from './types.js';

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function modelsUrl(baseUrl: string): string {
  const root = normalizeBaseUrl(baseUrl);
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/models`;
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

function responseError(response: Response): ProviderError {
  const retry = retryAfterMs(response.headers);
  const metadata = { status: response.status, ...(retry === undefined ? {} : { retryAfterMs: retry }) };
  if (response.status === 401 || response.status === 403) return new ProviderError('auth', metadata);
  if (response.status === 408) return new ProviderError('connection', metadata);
  if (response.status === 409 || response.status === 429) return new ProviderError('rate_limit', metadata);
  if (response.status >= 500) return new ProviderError('connection', metadata);
  return new ProviderError('protocol', metadata);
}

export function createOpenAICompatibleClient(profile: OpenAICompatibleProfile): OpenAICompatibleClient {
  return {
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
      const headers = new Headers(profile.headers);
      if (profile.apiKey !== undefined && !headers.has('authorization')) {
        headers.set('authorization', `Bearer ${profile.apiKey}`);
      }
      let response: Response;
      try {
        response = await fetch(modelsUrl(profile.baseUrl), { method: 'GET', headers, signal });
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          throw new ProviderError('aborted');
        }
        throw new ProviderError('connection');
      }
      if (!response.ok) throw responseError(response);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError('protocol', { status: response.status });
      }
      if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
        throw new ProviderError('protocol', { status: response.status });
      }
      return (payload as { data: unknown[] }).data.flatMap((model): ModelInfo[] => {
        if (typeof model !== 'object' || model === null || typeof (model as { id?: unknown }).id !== 'string') return [];
        const value = model as { id: string; owned_by?: unknown };
        return [{ id: value.id, ...(typeof value.owned_by === 'string' ? { ownedBy: value.owned_by } : {}) }];
      });
    },
  };
}

export async function listModels(profile: OpenAICompatibleProfile, signal?: AbortSignal): Promise<ModelInfo[]> {
  return createOpenAICompatibleClient(profile).listModels(signal);
}
