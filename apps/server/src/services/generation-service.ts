import { randomUUID } from 'node:crypto';
import type { GenerationMode, Message, MessageVariant, ProviderProfile } from '@tavernnext/domain';
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
import { createMvuRuntimeService } from './mvu-runtime-service.js';
import { createReasoningCompatibilityService } from './reasoning-compat-service.js';
import { applyScenePatch, type SceneService } from '../scenes/scene-service.js';

export type GenerationEvent =
  | { type: 'started'; generationId: string }
  | { type: 'reasoning_delta'; text: string }
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
  reuseLastUser?: boolean;
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
  reasoningCompatibility: boolean;
}

type PreparedGeneration =
  | (PreparedGenerationBase & { kind: 'chat'; request: ChatRequest })
  | (PreparedGenerationBase & { kind: 'text'; request: TextRequest });

export interface GenerationService {
  start(input: GenerationInput): Promise<StartGenerationResult>;
  triggerLastUser(conversationId: string): Promise<StartGenerationResult>;
  cancel(generationId: string): boolean;
  isConversationActive(conversationId: string): boolean;
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
  reasoningCompatibility: boolean,
): PreparedGeneration {
  const base: PreparedGenerationBase = {
    generationId,
    conversationId: payload.input.conversationId,
    provider,
    payload,
    reasoningCompatibility,
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
  sceneService?: SceneService;
}): GenerationService {
  const { database, repositories, providerClientFactory } = options;
  const promptSnapshots = options.promptSnapshotService ?? createPromptSnapshotService({
    database,
    repositories,
    tokenizerRuntime: options.tokenizerRuntime ?? defaultTokenizerRuntime(),
  });
  const mvu = createMvuRuntimeService(repositories);
  const reasoningCompatibility = createReasoningCompatibilityService(repositories);
  const sceneService = options.sceneService;
  const activeByConversation = new Map<string, string>();
  const activeById = new Map<string, ActiveGeneration>();

  function providerEvents(
    prepared: PreparedGeneration,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const client = providerClientFactory(prepared.provider);
    return prepared.kind === 'chat'
      ? client.streamChat(prepared.request, signal)
      : client.streamText(prepared.request, signal);
  }

  async function* stream(prepared: PreparedGeneration, active: ActiveGeneration): AsyncIterable<GenerationEvent> {
    const { controller } = active;
    const mode = prepared.payload.input.mode;
    const siblingMode = mode === 'swipe' || mode === 'regenerate';
    let targetMessage: Message | undefined;
    let variant: MessageVariant | undefined;
    let initializationError: unknown;
    if (mode !== 'normal') {
      targetMessage = repositories.messages.get(prepared.payload.input.targetMessageId!);
      variant = repositories.messageVariants.get(prepared.payload.input.targetVariantId!);
      if (targetMessage === undefined || variant === undefined
        || variant.messageId !== targetMessage.id || targetMessage.activeVariantId !== variant.id) {
        initializationError = new PromptSnapshotError('snapshot_stale');
      }
      if (siblingMode) variant = undefined;
    }
    let content = mode === 'continue' ? variant?.content ?? '' : '';
    const initialContent = content;
    let reasoning = mode === 'continue' ? variant?.reasoning ?? '' : '';
    let hasDelta = false;
    let hasReasoningDelta = false;
    let finishReason = 'stop';
    let outcome: 'completed' | 'aborted' | 'failed' = 'aborted';
    let failureCode = 'upstream_error';
    let providerIterator: AsyncIterator<ProviderEvent> | undefined;
    let sceneStateUpdate: { id: string; revision: number; value: Record<string, unknown> } | undefined;

    const flush = (status: MessageVariant['status'] = 'streaming') => {
      if (variant === undefined) return;
      const updated = repositories.messageVariants.update(variant.id, variant.revision, {
        content,
        ...(reasoning === '' ? {} : { reasoning }),
        status,
        finishReason: status === 'completed' ? finishReason : undefined,
        ...(mode === 'continue' && hasDelta ? {
          continuationBoundaries: [
            ...variant.continuationBoundaries,
            ...(variant.continuationBoundaries.at(-1) === prepared.payload.input.continuationByteBoundary
              ? []
              : [prepared.payload.input.continuationByteBoundary!]),
          ],
        } : {}),
      });
      if (!updated.ok) throw new Error(`Unable to flush generation variant: ${updated.reason}`);
      variant = updated.value;
    };

    const beginPersistence = () => {
      database.transaction(() => {
        if (mode === 'normal') {
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
            ordinal: 0,
            content,
            ...(reasoning === '' ? {} : { reasoning }),
            status: 'streaming',
            continuationBoundaries: [],
          });
          const linked = repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id });
          if (!linked.ok) throw new Error(`Unable to link generation variant: ${linked.reason}`);
        } else if (siblingMode) {
          const siblings = repositories.messageVariants.listByMessageId(targetMessage!.id);
          const ordinal = siblings.reduce((maximum, sibling) => Math.max(maximum, sibling.ordinal), -1) + 1;
          variant = repositories.messageVariants.create({
            id: randomUUID(),
            messageId: targetMessage!.id,
            ordinal,
            content,
            ...(reasoning === '' ? {} : { reasoning }),
            status: 'streaming',
            continuationBoundaries: [],
          });
        } else {
          flush();
        }
      });
    };

    const selectSibling = () => {
      if (!siblingMode || variant === undefined || targetMessage === undefined) return;
      const linked = repositories.messages.update(targetMessage.id, targetMessage.revision, {
        activeVariantId: variant.id,
      });
      if (!linked.ok) throw new Error(`Unable to select generation variant: ${linked.reason}`);
      targetMessage = linked.value;
    };

    try {
      yield { type: 'started', generationId: prepared.generationId };
      if (initializationError !== undefined) throw initializationError;
      providerIterator = providerEvents(prepared, controller.signal)[Symbol.asyncIterator]();
      for (;;) {
        if (controller.signal.aborted) throw new ProviderError('aborted');
        const next = await providerIterator.next();
        if (next.done) break;
        const event = next.value;
        if (event.type === 'reasoning_delta') {
          if (event.text === '') continue;
          reasoning += event.text;
          hasReasoningDelta = true;
          // Reasoning streams can be very large. Keep them live in the SSE
          // response, then persist once with the first final-content delta or
          // terminal event instead of rewriting the full SQLite image for
          // every reasoning chunk.
          yield { type: 'reasoning_delta', text: event.text };
          continue;
        }
        if (event.type === 'delta') {
          if (event.text === '') continue;
          content += event.text;
          hasDelta = true;
          // The SSE response is the live source of truth. Persist once at the
          // terminal boundary so large outputs do not repeatedly export the
          // complete sql.js database while they are still streaming.
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
      } else if (!hasDelta && hasReasoningDelta) {
        // Some reasoning-capable providers place the entire requested answer
        // in reasoning_content and leave content empty. When the caller has
        // explicitly streamed that visible reasoning, promote it to the final
        // assistant response instead of treating a complete answer as empty.
        content = reasoning;
        reasoning = '';
        hasDelta = true;
      } else if (!hasDelta) {
        outcome = 'failed';
        failureCode = 'empty_response';
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof ProviderError && error.code === 'aborted')) {
        outcome = 'aborted';
      } else {
        outcome = 'failed';
        failureCode = safeFailureCode(error);
      }
    } finally {
      if (providerIterator?.return !== undefined) {
        try {
          await providerIterator.return();
        } catch {
          // Closing the provider transport must not replace the generation's primary outcome.
        }
      }
      if (outcome === 'aborted') controller.abort();
      if (outcome === 'completed') {
        const extracted = reasoningCompatibility.extract(prepared.reasoningCompatibility, content, reasoning);
        content = extracted.content; reasoning = extracted.reasoning;
        const conversation = repositories.conversations.get(prepared.conversationId);
        const scene = conversation?.sceneId === undefined ? undefined : sceneService?.get(conversation.sceneId);
        const state = scene === undefined ? undefined : sceneService?.state(prepared.conversationId);
        const host = scene === undefined ? undefined : sceneService?.module(scene);
        if (conversation !== undefined && scene !== undefined && state !== undefined && host !== undefined) {
          try {
            const processed = await host.call<{ displayContent?: unknown; statePatch?: unknown }>('afterGeneration', {
              content, reasoning, state: state.value, setup: conversation.setup ?? {},
              playerProfile: conversation.playerProfile, manifest: scene.manifest,
            });
            if (typeof processed.displayContent === 'string') content = processed.displayContent;
            if (processed.statePatch !== undefined) {
              sceneStateUpdate = { id: state.id, revision: state.revision, value: applyScenePatch(state.value, processed.statePatch) };
            }
          } catch {
            // Preserve the raw provider response and leave Scene state unchanged.
            // The Scene can expose a reprocess action without losing the reply.
          }
        }
      }
      try {
        database.transaction(() => {
          if (variant === undefined && (hasDelta || hasReasoningDelta)) beginPersistence();
          if (variant !== undefined && (hasDelta || hasReasoningDelta)) flush(outcome);
          if (outcome === 'completed' && variant !== undefined && hasDelta) {
            mvu.commitCompletedVariant(
              prepared.conversationId,
              variant.id,
              mode === 'continue' ? content.slice(initialContent.length) : content,
            );
          }
          if (outcome === 'completed' && sceneStateUpdate !== undefined) {
            const updated = repositories.conversationSceneStates.update(
              sceneStateUpdate.id, sceneStateUpdate.revision, { value: sceneStateUpdate.value },
            );
            if (!updated.ok) throw new Error(`Unable to commit Scene state: ${updated.reason}`);
          }
          if (hasDelta || hasReasoningDelta) selectSibling();
          if (outcome === 'completed' && mode === 'normal') promptSnapshots.commitTimedState(prepared.payload);
        });
      } catch (error) {
        outcome = 'failed';
        failureCode = safeFailureCode(error);
        try {
          if (hasDelta || hasReasoningDelta) {
            const persisted = variant === undefined ? undefined : repositories.messageVariants.get(variant.id);
            if (persisted !== undefined) {
              variant = persisted;
              if (siblingMode) targetMessage = repositories.messages.get(prepared.payload.input.targetMessageId!);
              if (variant.status !== 'failed') database.transaction(() => {
                flush('failed');
                selectSibling();
              });
            } else if (mode === 'normal' || siblingMode) {
              variant = undefined;
              if (siblingMode) {
                targetMessage = repositories.messages.get(prepared.payload.input.targetMessageId!);
                if (targetMessage === undefined) throw new Error('recovery_target_missing');
              }
              database.transaction(() => {
                beginPersistence();
                flush('failed');
                selectSibling();
              });
            }
          }
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

  const service: GenerationService = {
    async start(input) {
      if (input.mode === 'normal' && (typeof input.userText !== 'string' || input.userText.trim() === '')) {
        return { ok: false, reason: 'invalid_user_text' };
      }
      if (input.mode !== 'normal' && input.userText !== undefined) return { ok: false, reason: 'invalid_user_text' };
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
        if (sceneService !== undefined) {
          const conversation = repositories.conversations.get(input.conversationId);
          const scene = conversation?.sceneId === undefined ? undefined : sceneService.get(conversation.sceneId);
          const state = scene === undefined ? undefined : sceneService.state(input.conversationId);
          const host = scene === undefined ? undefined : sceneService.module(scene);
          if (conversation !== undefined && scene !== undefined && state !== undefined && host !== undefined) {
            const before = await host.call<{ statePatch?: unknown }>('beforeGeneration', {
              state: state.value, setup: conversation.setup ?? {}, playerProfile: conversation.playerProfile,
              manifest: scene.manifest, mode: input.mode, userText: input.userText,
            });
            if (before.statePatch !== undefined) sceneService.patchState(
              conversation.id, state.revision, before.statePatch,
            );
          }
        }
        const accepted = input.snapshotId === undefined
          ? await promptSnapshots.createAndAccept(input, generationId)
          : await promptSnapshots.acceptExisting({ ...input, snapshotId: input.snapshotId });
        const prepared = preparedRequest(
          generationId,
          accepted.provider,
          accepted.payload,
          reasoningCompatibility.resolve(accepted.payload),
        );
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
    async triggerLastUser(conversationId) {
      if (activeByConversation.has(conversationId)) return { ok: false, reason: 'generation_active' };
      const conversation = repositories.conversations.get(conversationId);
      if (conversation === undefined) return { ok: false, reason: 'not_found' };
      const last = repositories.messages.listByConversationId(conversationId).at(-1);
      if (last?.role !== 'user' || last.content.trim() === '') return { ok: false, reason: 'invalid_user_text' };
      return service.start({
        conversationId, conversationRevision: conversation.revision,
        mode: 'normal', userText: last.content, reuseLastUser: true,
      });
    },
    cancel(generationId) {
      const active = activeById.get(generationId);
      if (active === undefined) return false;
      active.controller.abort();
      if (active.state === 'reserved') active.cleanup();
      return true;
    },
    isConversationActive(conversationId) {
      return activeByConversation.has(conversationId);
    },
  };
  return service;
}
