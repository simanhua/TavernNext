import { randomUUID } from 'node:crypto';
import type { GenerationMode, MessageVariant, ProviderProfile } from '@tavernnext/domain';
import type {
  ChatRequest,
  OpenAICompatibleClient,
  ProviderEvent,
  TextRequest,
} from '@tavernnext/provider-openai-compatible';
import { ProviderError } from '@tavernnext/provider-openai-compatible';
import { countMessages, countText, selectTokenizer } from '@tavernnext/tokenizer-engine';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import {
  createPromptSnapshotService,
  PromptSnapshotError,
  type PromptSnapshotErrorCode,
  type PromptSnapshotPayload,
  type PromptSnapshotService,
  type ServerTokenizerRuntime,
} from './prompt-snapshot-service.js';

export type GenerationEvent =
  | { type: 'started'; generationId: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed'; finishReason: string }
  | { type: 'aborted' }
  | { type: 'failed'; code: string };

export interface GenerationInput {
  conversationId: string;
  conversationRevision: number;
  mode: GenerationMode;
  userText?: string;
  snapshotId?: string;
  seed?: string | number;
  messageIndex?: number;
}

export type ProviderClientFactory = (profile: ProviderProfile) => OpenAICompatibleClient;

export type StartGenerationFailure = 'generation_active' | PromptSnapshotErrorCode;
export type StartGenerationResult =
  | { ok: true; generationId: string; events: AsyncIterable<GenerationEvent> }
  | { ok: false; reason: StartGenerationFailure };

interface ActiveGeneration {
  generationId: string;
  conversationId: string;
  controller: AbortController;
  state: 'reserved' | 'iterating' | 'closed';
  reservationTimer?: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

const RESERVED_GENERATION_TIMEOUT_MS = 30_000;

interface PreparedGenerationBase {
  generationId: string;
  conversationId: string;
  provider: ProviderProfile;
  payload: PromptSnapshotPayload;
}

type PreparedGeneration =
  | (PreparedGenerationBase & { kind: 'chat'; request: ChatRequest })
  | (PreparedGenerationBase & { kind: 'text'; request: TextRequest });

export interface GenerationService {
  start(input: GenerationInput): Promise<StartGenerationResult>;
  cancel(generationId: string): boolean;
}

function safeFailureCode(error: unknown): string {
  return error instanceof ProviderError ? error.code : 'upstream_error';
}

function defaultTokenizerRuntime(): ServerTokenizerRuntime {
  return {
    selectTokenizer,
    countText: (text, decision) => countText(text, decision),
    countMessages: (messages, decision) => countMessages(messages, decision),
  };
}

function preparedRequest(
  generationId: string,
  provider: ProviderProfile,
  payload: PromptSnapshotPayload,
): PreparedGeneration {
  const base: PreparedGenerationBase = {
    generationId,
    conversationId: payload.input.conversationId,
    provider,
    payload,
  };
  if (payload.kind === 'chat' && 'messages' in payload.compiledRequest) {
    return { ...base, kind: 'chat', request: payload.compiledRequest };
  }
  if (payload.kind === 'text' && 'prompt' in payload.compiledRequest) {
    return { ...base, kind: 'text', request: payload.compiledRequest };
  }
  throw new PromptSnapshotError('snapshot_invalid');
}

export function createGenerationService(options: {
  database: TavernDatabase;
  repositories: Repositories;
  providerClientFactory: ProviderClientFactory;
  promptSnapshotService?: PromptSnapshotService;
  tokenizerRuntime?: ServerTokenizerRuntime;
}): GenerationService {
  const { database, repositories, providerClientFactory } = options;
  const promptSnapshots = options.promptSnapshotService ?? createPromptSnapshotService({
    database,
    repositories,
    tokenizerRuntime: options.tokenizerRuntime ?? defaultTokenizerRuntime(),
  });
  const activeByConversation = new Map<string, string>();
  const activeById = new Map<string, ActiveGeneration>();

  async function* providerEvents(
    prepared: PreparedGeneration,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const client = providerClientFactory(prepared.provider);
    if (prepared.kind === 'chat') yield* client.streamChat(prepared.request, signal);
    else yield* client.streamText(prepared.request, signal);
  }

  async function* stream(prepared: PreparedGeneration, active: ActiveGeneration): AsyncIterable<GenerationEvent> {
    const { controller } = active;
    let variant: MessageVariant | undefined;
    let content = '';
    let persistedContent = '';
    let finishReason = 'stop';
    let outcome: 'completed' | 'aborted' | 'failed' = 'aborted';
    let failureCode = 'upstream_error';
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let timerError: unknown;

    const flush = (status: MessageVariant['status'] = 'streaming') => {
      if (variant === undefined) return;
      if (status === 'streaming' && persistedContent === content) return;
      const updated = repositories.messageVariants.update(variant.id, variant.revision, {
        content,
        status,
        ...(status === 'completed' ? { finishReason } : {}),
      });
      if (!updated.ok) throw new Error(`Unable to flush generation variant: ${updated.reason}`);
      variant = updated.value;
      persistedContent = content;
    };

    const createAssistant = () => {
      database.transaction(() => {
        const message = repositories.messages.create({
          id: randomUUID(),
          conversationId: prepared.conversationId,
          role: 'assistant',
          content: '',
          activeVariantId: null,
        });
        variant = repositories.messageVariants.create({
          id: randomUUID(),
          messageId: message.id,
          content,
          status: 'streaming',
        });
        const linked = repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id });
        if (!linked.ok) throw new Error(`Unable to link generation variant: ${linked.reason}`);
      });
      persistedContent = content;
      flushTimer = setInterval(() => {
        try {
          flush();
        } catch (error) {
          timerError = error;
          controller.abort();
        }
      }, 250);
    };

    try {
      yield { type: 'started', generationId: prepared.generationId };
      for await (const event of providerEvents(prepared, controller.signal)) {
        if (timerError !== undefined) throw timerError;
        if (controller.signal.aborted) throw new ProviderError('aborted');
        if (event.type === 'delta') {
          if (event.text === '') continue;
          content += event.text;
          if (variant === undefined) createAssistant();
          else if (content.length - persistedContent.length >= 256) flush();
          yield { type: 'delta', text: event.text };
          continue;
        }
        if (event.type === 'usage') {
          yield { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens };
          continue;
        }
        finishReason = event.finishReason;
        outcome = 'completed';
        break;
      }
      if (controller.signal.aborted) throw new ProviderError('aborted');
      if (outcome !== 'completed') {
        outcome = 'failed';
        failureCode = 'protocol';
      }
    } catch (error) {
      if (timerError !== undefined) {
        outcome = 'failed';
        failureCode = safeFailureCode(timerError);
      } else if (controller.signal.aborted || (error instanceof ProviderError && error.code === 'aborted')) {
        outcome = 'aborted';
      } else {
        outcome = 'failed';
        failureCode = safeFailureCode(error);
      }
    } finally {
      if (flushTimer !== undefined) clearInterval(flushTimer);
      if (outcome === 'aborted') controller.abort();
      try {
        if (variant !== undefined) flush(outcome);
        if (outcome === 'completed') promptSnapshots.commitTimedState(prepared.payload);
      } catch (error) {
        outcome = 'failed';
        failureCode = safeFailureCode(error);
        try {
          if (variant !== undefined && variant.status !== 'failed') flush('failed');
        } catch {
          // The original persistence failure is the only externally observable code.
        }
      }
      active.cleanup();
    }

    if (outcome === 'completed') yield { type: 'completed', finishReason };
    else if (outcome === 'aborted') yield { type: 'aborted' };
    else yield { type: 'failed', code: failureCode };
  }

  function lifecycleEvents(prepared: PreparedGeneration, active: ActiveGeneration): AsyncIterableIterator<GenerationEvent> {
    const source = stream(prepared, active)[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (active.state === 'closed') return { done: true, value: undefined };
        if (active.state === 'reserved') {
          if (active.reservationTimer !== undefined) clearTimeout(active.reservationTimer);
          active.reservationTimer = undefined;
          active.state = 'iterating';
        }
        return source.next();
      },
      async return(value) {
        if (active.state === 'reserved') {
          active.controller.abort();
          active.cleanup();
          return { done: true, value };
        }
        if (active.state === 'closed') return { done: true, value };
        if (source.return !== undefined) return source.return(value);
        active.controller.abort();
        active.cleanup();
        return { done: true, value };
      },
    };
  }

  return {
    async start(input) {
      if (input.mode !== 'normal') return { ok: false, reason: 'unsupported_mode' };
      if (typeof input.userText !== 'string' || input.userText.trim() === '') {
        return { ok: false, reason: 'invalid_user_text' };
      }
      if (activeByConversation.has(input.conversationId)) return { ok: false, reason: 'generation_active' };
      const generationId = input.snapshotId ?? randomUUID();
      if (activeById.has(generationId)) return { ok: false, reason: 'generation_active' };
      const controller = new AbortController();
      const active: ActiveGeneration = {
        generationId,
        conversationId: input.conversationId,
        controller,
        state: 'reserved',
        cleanup() {
          if (active.state === 'closed') return;
          if (active.reservationTimer !== undefined) clearTimeout(active.reservationTimer);
          active.reservationTimer = undefined;
          active.state = 'closed';
          if (activeByConversation.get(active.conversationId) === active.generationId) {
            activeByConversation.delete(active.conversationId);
          }
          activeById.delete(active.generationId);
        },
      };
      activeByConversation.set(input.conversationId, generationId);
      activeById.set(generationId, active);
      try {
        const accepted = input.snapshotId === undefined
          ? await promptSnapshots.createAndAccept(input, generationId)
          : promptSnapshots.acceptExisting({ ...input, snapshotId: input.snapshotId });
        const prepared = preparedRequest(generationId, accepted.provider, accepted.payload);
        active.reservationTimer = setTimeout(() => {
          if (active.state !== 'reserved') return;
          active.controller.abort();
          active.cleanup();
        }, RESERVED_GENERATION_TIMEOUT_MS);
        active.reservationTimer.unref?.();
        return { ok: true, generationId, events: lifecycleEvents(prepared, active) };
      } catch (error) {
        active.cleanup();
        if (error instanceof PromptSnapshotError) return { ok: false, reason: error.code };
        throw error;
      }
    },
    cancel(generationId) {
      const active = activeById.get(generationId);
      if (active === undefined) return false;
      active.controller.abort();
      if (active.state === 'reserved') active.cleanup();
      return true;
    },
  };
}
