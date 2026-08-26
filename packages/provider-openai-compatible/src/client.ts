import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Usage,
} from '@earendil-works/pi-ai';
import { abortedError, isProviderError, ProviderError } from './errors.js';
import { agentToolCallCapability } from './provider-catalog.js';
import { parseSse } from './sse.js';
import type {
  ChatRequest,
  ModelInfo,
  OpenAICompatibleClient,
  OpenAICompatibleProfile,
  PiProviderProfile,
  ProviderEvent,
  TextRequest,
} from './types.js';

type CompletionRequest = ChatRequest | TextRequest;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function endpoint(baseUrl: string, path: '/models' | '/chat/completions' | '/completions'): string {
  return `${piBaseUrl(baseUrl)}${path}`;
}

function piBaseUrl(baseUrl: string): string {
  const root = normalizeBaseUrl(baseUrl);
  return root.endsWith('/v1') ? root : `${root}/v1`;
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
  if (typeof body === 'string') {
    return /context (length|window)|maximum context|context_length_exceeded/i.test(body);
  }
  if (typeof body !== 'object' || body === null) return false;
  const error = 'error' in body && typeof body.error === 'object' && body.error !== null ? body.error : body;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return code === 'context_length_exceeded' || /context (length|window)|maximum context/i.test(message);
}

function classifiedProviderError(status: number, retryAfter: string | null, details: unknown): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('auth', { status });
  if (status === 429) return new ProviderError('rate_limit', {
    status,
    retryAfterMs: retryAfterMs(retryAfter),
  });
  if (isContextOverflow(status, details)) return new ProviderError('context_overflow', { status });
  return new ProviderError('protocol', { status });
}

async function responseError(response: Response): Promise<ProviderError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return classifiedProviderError(response.status, response.headers.get('retry-after'), body);
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
    const reasoning = isChat ? delta?.reasoning_content ?? message?.reasoning_content : undefined;
    const text = isChat ? delta?.content ?? message?.content : choice.text;
    if (typeof reasoning === 'string' && reasoning !== '') events.push({ type: 'reasoning_delta', text: reasoning });
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

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function piModel(profile: OpenAICompatibleProfile, request: ChatRequest): Model<'openai-completions'> {
  return {
    id: request.model,
    name: request.model,
    api: 'openai-completions',
    provider: 'tavernnext-openai-compatible',
    baseUrl: piBaseUrl(profile.baseUrl),
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: request.maxTokens ?? 384_000,
    compat: {
      supportsFinishReason: false,
      maxTokensField: 'max_tokens',
    },
  };
}

function assistantHistory(content: string, model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: 0,
  };
}

function piContext(request: ChatRequest, model: Model<Api>): Context {
  const systemPrompt = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages: Message[] = request.messages.flatMap((message): Message[] => {
    if (message.role === 'system') return [];
    if (message.role === 'assistant') return [assistantHistory(message.content, model)];
    return [{ role: 'user', content: message.content, timestamp: 0 }];
  });
  return {
    ...(systemPrompt === '' ? {} : { systemPrompt }),
    messages,
  };
}

function piFailure(
  status: number | undefined,
  responseHeaders: Record<string, string>,
  message: string,
  signal?: AbortSignal,
): ProviderError {
  if (signal?.aborted) return abortedError();
  if (status === 200 && /connect|fetch|network|socket|terminated|premature|closed/i.test(message)) {
    return new ProviderError('connection');
  }
  if (status !== undefined) return classifiedProviderError(status, responseHeaders['retry-after'] ?? null, message);
  const statusMatch = /\b(4\d\d|5\d\d)\b/.exec(message);
  if (statusMatch !== null) {
    const parsedStatus = Number(statusMatch[1]);
    return classifiedProviderError(parsedStatus, responseHeaders['retry-after'] ?? null, message);
  }
  return new ProviderError('connection');
}

async function* streamChatWithPi(
  profile: OpenAICompatibleProfile,
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  if (signal?.aborted) throw abortedError();
  const model = piModel(profile, request);
  let responseStatus: number | undefined;
  let responseHeaders: Record<string, string> = {};
  const observedFetch: typeof fetch = async (input, init) => {
    const requestHeaders = new Headers(init?.headers);
    const configuredAuthorization = Object.entries(profile.headers ?? {})
      .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    if (profile.apiKey === undefined || profile.apiKey === '') {
      if (configuredAuthorization === undefined) requestHeaders.delete('authorization');
      else requestHeaders.set('authorization', configuredAuthorization);
    }
    const requestInit = { ...init, headers: requestHeaders };
    const response = await fetch(input, requestInit);
    responseStatus = response.status;
    responseHeaders = Object.fromEntries(response.headers.entries());
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return response;
    }
    const body = await response.text();
    let streamedFrames = [body];
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (Array.isArray(parsed.choices)) {
        const first = parsed.choices[0];
        const choice = typeof first === 'object' && first !== null ? first as Record<string, unknown> : undefined;
        const message = typeof choice?.message === 'object' && choice.message !== null
          ? choice.message as Record<string, unknown>
          : undefined;
        if (choice !== undefined && message !== undefined) {
          const reasoning = message.reasoning_content;
          const content = message.content;
          streamedFrames = [
            ...(typeof reasoning === 'string' && reasoning !== '' ? [JSON.stringify({
              choices: [{ ...choice, message: undefined, finish_reason: null, delta: { reasoning_content: reasoning } }],
            })] : []),
            JSON.stringify({
              ...parsed,
              choices: [{ ...choice, message: undefined, delta: { content } }],
            }),
          ];
        }
      }
    } catch {
      // The Pi stream will report malformed JSON through the normal protocol error path.
    }
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    return new Response(`${streamedFrames.map((frame) => `data: ${frame}\n\n`).join('')}data: [DONE]\n\n`, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  const events = stream(model, piContext(request, model), {
    signal,
    apiKey: profile.apiKey ?? 'tavernnext-keyless-endpoint',
    headers: profile.headers,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    maxRetries: 0,
    fetch: observedFetch,
    ...(request.stop === undefined ? {} : { samplingParams: { stop: request.stop } }),
    onResponse(response) {
      responseStatus = response.status;
      responseHeaders = response.headers;
    },
  });
  for await (const event of events) {
    if (event.type === 'thinking_delta' && event.delta !== '') {
      yield { type: 'reasoning_delta', text: event.delta };
    } else if (event.type === 'text_delta' && event.delta !== '') {
      yield { type: 'delta', text: event.delta };
    } else if (event.type === 'done') {
      const usage = event.message.usage;
      if (usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0) {
        yield {
          type: 'usage',
          inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
          outputTokens: usage.output,
        };
      }
      yield { type: 'completed', finishReason: event.message.rawStopReason ?? event.reason };
    } else if (event.type === 'error') {
      throw piFailure(responseStatus, responseHeaders, event.error.errorMessage ?? '', signal);
    }
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
    streamChat: (request, signal) => streamChatWithPi(profile, request, signal),
    streamText: (request, signal) => streamCompletion(profile, request, signal, false),
  };
}

export function createPiProviderClient(
  profile: PiProviderProfile,
  dependencies: { fetch?: typeof fetch } = {},
): OpenAICompatibleClient {
  const models = builtinModels();
  const provider = models.getProvider(profile.providerId);
  const model = models.getModel(profile.providerId, profile.modelId);
  if (provider === undefined || model === undefined || !agentToolCallCapability(model.api)) {
    throw new ProviderError('protocol');
  }
  if (normalizeBaseUrl(model.baseUrl) !== normalizeBaseUrl(profile.baseUrl)) {
    throw new ProviderError('auth');
  }
  return {
    async listModels(): Promise<ModelInfo[]> {
      return provider.getModels().map((candidate) => ({ id: candidate.id }));
    },
    async *streamChat(request, signal): AsyncIterable<ProviderEvent> {
      if (signal?.aborted) throw abortedError();
      let responseStatus: number | undefined;
      let responseHeaders: Record<string, string> = {};
      const events = models.stream(model, piContext(request, model), {
        signal,
        apiKey: profile.apiKey,
        headers: profile.headers,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        maxRetries: 0,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        ...(request.stop === undefined ? {} : { samplingParams: { stop: request.stop } }),
        onResponse(response) {
          responseStatus = response.status;
          responseHeaders = response.headers;
        },
      });
      for await (const event of events) {
        if (event.type === 'thinking_delta' && event.delta !== '') {
          yield { type: 'reasoning_delta', text: event.delta };
        } else if (event.type === 'text_delta' && event.delta !== '') {
          yield { type: 'delta', text: event.delta };
        } else if (event.type === 'done') {
          const usage = event.message.usage;
          if (usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0) {
            yield {
              type: 'usage',
              inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
              outputTokens: usage.output,
            };
          }
          yield { type: 'completed', finishReason: event.message.rawStopReason ?? event.reason };
        } else if (event.type === 'error') {
          throw piFailure(responseStatus, responseHeaders, event.error.errorMessage ?? '', signal);
        }
      }
    },
    async *streamText(): AsyncIterable<ProviderEvent> {
      throw new ProviderError('protocol');
    },
  };
}

export async function listModels(profile: OpenAICompatibleProfile, signal?: AbortSignal): Promise<ModelInfo[]> {
  return createOpenAICompatibleClient(profile).listModels(signal);
}
