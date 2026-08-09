import { abortedError, isProviderError, ProviderError } from './errors.js';
import { parseSse } from './sse.js';
import type { ChatRequest, ModelInfo, OpenAICompatibleClient, OpenAICompatibleProfile, ProviderEvent, TextRequest } from './types.js';

type CompletionRequest = ChatRequest | TextRequest;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function endpoint(baseUrl: string, path: '/models' | '/chat/completions' | '/completions'): string {
  const root = normalizeBaseUrl(baseUrl);
  return `${root.endsWith('/v1') ? root : `${root}/v1`}${path}`;
}

function headers(profile: OpenAICompatibleProfile): Headers {
  const result = new Headers({ accept: 'application/json' });
  for (const [name, value] of Object.entries(profile.headers ?? {})) result.set(name, value);
  if (profile.apiKey !== undefined && profile.apiKey !== '') result.set('authorization', `Bearer ${profile.apiKey}`);
  return result;
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function isContextOverflow(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 413) return false;
  if (typeof body !== 'object' || body === null) return false;
  const error = 'error' in body && typeof body.error === 'object' && body.error !== null ? body.error : body;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return code === 'context_length_exceeded' || /context (length|window)|maximum context/i.test(message);
}

async function responseError(response: Response): Promise<ProviderError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.status === 401 || response.status === 403) return new ProviderError('auth', { status: response.status });
  if (response.status === 429) return new ProviderError('rate_limit', {
    status: response.status,
    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
  });
  if (isContextOverflow(response.status, body)) return new ProviderError('context_overflow', { status: response.status });
  return new ProviderError('protocol', { status: response.status });
}

function payloadFor(request: CompletionRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { model: request.model, stream: true };
  if ('messages' in request) payload.messages = request.messages;
  else payload.prompt = request.prompt;
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
  if (request.stop !== undefined) payload.stop = request.stop;
  return payload;
}

function numberAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventsFromJson(payload: unknown, isChat: boolean): ProviderEvent[] {
  if (typeof payload !== 'object' || payload === null) throw new ProviderError('protocol');
  const record = payload as Record<string, unknown>;
  const events: ProviderEvent[] = [];
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices[0];
  if (typeof firstChoice === 'object' && firstChoice !== null) {
    const choice = firstChoice as Record<string, unknown>;
    const delta = typeof choice.delta === 'object' && choice.delta !== null ? choice.delta as Record<string, unknown> : undefined;
    const message = typeof choice.message === 'object' && choice.message !== null ? choice.message as Record<string, unknown> : undefined;
    const text = isChat ? delta?.content ?? message?.content : choice.text;
    if (typeof text === 'string' && text !== '') events.push({ type: 'delta', text });
  }
  const usage = typeof record.usage === 'object' && record.usage !== null ? record.usage as Record<string, unknown> : undefined;
  const inputTokens = numberAt(usage?.prompt_tokens);
  const outputTokens = numberAt(usage?.completion_tokens);
  if (inputTokens !== undefined && outputTokens !== undefined) events.push({ type: 'usage', inputTokens, outputTokens });
  if (typeof firstChoice === 'object' && firstChoice !== null) {
    const finishReason = (firstChoice as Record<string, unknown>).finish_reason;
    if (typeof finishReason === 'string' && finishReason !== '') {
      events.push({ type: 'completed', finishReason });
    }
  }
  return events;
}

async function* streamCompletion(profile: OpenAICompatibleProfile, request: CompletionRequest, signal: AbortSignal | undefined, isChat: boolean): AsyncIterable<ProviderEvent> {
  if (signal?.aborted) throw abortedError();
  const requestHeaders = headers(profile);
  requestHeaders.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(endpoint(profile.baseUrl, isChat ? '/chat/completions' : '/completions'), {
      method: 'POST', headers: requestHeaders, body: JSON.stringify(payloadFor(request)), signal,
    });
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    if (isProviderError(error)) throw error;
    throw new ProviderError('connection');
  }

  if (!response.ok) throw await responseError(response);
  let completed = false;
  try {
    if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const payload = await response.json().catch(() => { throw new ProviderError('protocol'); });
      for (const event of eventsFromJson(payload, isChat)) {
        if (event.type === 'completed') completed = true;
        yield event;
      }
      if (!completed) yield { type: 'completed', finishReason: 'stop' };
      return;
    }
    if (response.body === null) throw new ProviderError('protocol');
    for await (const data of parseSse(response.body)) {
      if (signal?.aborted) throw abortedError();
      if (data === '[DONE]') {
        if (!completed) yield { type: 'completed', finishReason: 'stop' };
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new ProviderError('protocol');
      }
      for (const event of eventsFromJson(payload, isChat)) {
        if (event.type === 'completed') completed = true;
        yield event;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    if (isProviderError(error)) throw error;
    throw new ProviderError('connection');
  }
}

export function createOpenAICompatibleClient(profile: OpenAICompatibleProfile): OpenAICompatibleClient {
  return {
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
      if (signal?.aborted) throw abortedError();
      let response: Response;
      try {
        response = await fetch(endpoint(profile.baseUrl, '/models'), { headers: headers(profile), signal });
      } catch {
        if (signal?.aborted) throw abortedError();
        throw new ProviderError('connection');
      }
      if (!response.ok) throw await responseError(response);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError('protocol');
      }
      if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
        throw new ProviderError('protocol');
      }
      return (payload as { data: unknown[] }).data.flatMap((model): ModelInfo[] => {
        if (typeof model !== 'object' || model === null || typeof (model as { id?: unknown }).id !== 'string') return [];
        const value = model as { id: string; owned_by?: unknown };
        return [{ id: value.id, ...(typeof value.owned_by === 'string' ? { ownedBy: value.owned_by } : {}) }];
      });
    },
    streamChat: (request, signal) => streamCompletion(profile, request, signal, true),
    streamText: (request, signal) => streamCompletion(profile, request, signal, false),
  };
}

export async function listModels(profile: OpenAICompatibleProfile, signal?: AbortSignal): Promise<ModelInfo[]> {
  return createOpenAICompatibleClient(profile).listModels(signal);
}
