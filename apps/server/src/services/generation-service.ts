import { randomUUID } from 'node:crypto';
import {
  SceneAfterGenerationResultSchema,
  SceneBeforeGenerationResultSchema,
  type Message,
  type MessageVariant,
  type ProviderProfile,
  type ScenePatchOperation,
  type ScenePatchFailure,
  type SceneStateDiagnostic,
  type SceneManifest,
  roleplayDocumentFromMarkdown,
  roleplayDocumentPlainText,
  appendRoleplayMarkdown,
  type RoleplayDocument,
} from '@tavernnext/domain';
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
  type PromptSnapshotPayload,
  type AcceptedPromptSnapshot,
  type PromptSnapshotService,
  type ServerTokenizerRuntime,
} from './prompt-snapshot-service.js';
import type {
  SaveAgentRunInput,
  SaveAgentRuntime,
  SaveAgentRuntimeEvent,
  StartSaveAgentRunResult,
} from './save-agent-runtime.js';
import { createMvuRuntimeService } from './mvu-runtime-service.js';
import { createReasoningCompatibilityService } from './reasoning-compat-service.js';
import {
  applyScenePatchPartial,
  SceneServiceError,
  type SceneService,
} from '../scenes/scene-service.js';
import {
  SceneDirectorExecution,
  SceneDirectorRunError,
  type SceneDirectorLimits,
  type SceneDirectorTerminal,
  type PiAgentRuntimeFactory,
} from './scene-director-agent.js';
import { createSceneAgentToolFactory, type SceneAgentToolFactory } from './scene-agent-tools.js';
import { createSceneViewRuntimeFactory, type SceneViewRuntimeFactory } from './scene-view-runtime.js';

export type ProviderClientFactory = (profile: ProviderProfile) => OpenAICompatibleClient;

interface ActiveGeneration {
  generationId: string;
  conversationId: string;
  controller: AbortController;
  state: 'reserved' | 'iterating' | 'closed';
  reservationTimer?: ReturnType<typeof setTimeout>;
  detachExternalAbort?: () => void;
  releaseDeferredSnapshot?: () => void;
  cleanup(): void;
}

const RESERVED_GENERATION_TIMEOUT_MS = 30_000;

interface PreparedGenerationBase {
  generationId: string;
  conversationId: string;
  provider: ProviderProfile;
  payload: PromptSnapshotPayload;
  reasoningCompatibility: boolean;
  sceneDirector?: SceneDirectorExecution;
  deferredSnapshotCommit?: true;
  sceneTransition?: {
    stateRevision: number;
    baseValue: Record<string, unknown>;
    parentTransitionId: string | null;
    beforeOperations: ScenePatchOperation[];
    beforeFailures: ScenePatchFailure[];
    stagedValue: Record<string, unknown>;
    manifest: SceneManifest;
  };
}

type PreparedGeneration =
  | (PreparedGenerationBase & { kind: 'chat'; request: ChatRequest })
  | (PreparedGenerationBase & { kind: 'text'; request: TextRequest });

function safeFailureCode(error: unknown): string {
  if (error instanceof SceneDirectorRunError) return error.code;
  if (error instanceof SceneServiceError) return error.code;
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
  sceneTransition?: PreparedGenerationBase['sceneTransition'],
): PreparedGeneration {
  const base: PreparedGenerationBase = {
    generationId,
    conversationId: payload.input.conversationId,
    provider,
    payload,
    reasoningCompatibility,
    ...(sceneTransition === undefined ? {} : { sceneTransition }),
  };
  if (payload.kind === 'chat' && 'messages' in payload.compiledRequest) {
    return { ...base, kind: 'chat', request: payload.compiledRequest };
  }
  if (payload.kind === 'text' && 'prompt' in payload.compiledRequest) {
    return { ...base, kind: 'text', request: payload.compiledRequest };
  }
  throw new PromptSnapshotError('snapshot_invalid');
}

function sceneOutputProtocol(content: string): {
  displayContent: string;
  operations: unknown[];
  diagnostics: SceneStateDiagnostic[];
} {
  const opening = content.search(/<UpdateVariable>/i);
  if (opening < 0) {
    return {
      displayContent: content,
      operations: [],
      diagnostics: [{ source: 'scene-output-protocol', code: 'scene_patch_block_missing', failures: [] }],
    };
  }
  const displayContent = content.slice(0, opening).trim();
  const block = /<UpdateVariable>\s*(?:<Analysis>[\s\S]*?<\/Analysis>\s*)?<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>\s*<\/UpdateVariable>\s*$/i.exec(content);
  const duplicate = content.slice(opening + '<UpdateVariable>'.length).search(/<UpdateVariable>/i) >= 0;
  if (block === null || block.index !== opening || duplicate) {
    return {
      displayContent,
      operations: [],
      diagnostics: [{ source: 'scene-output-protocol', code: 'scene_patch_block_invalid', failures: [] }],
    };
  }
  try {
    const parsed = JSON.parse(block[1]!);
    if (!Array.isArray(parsed) || parsed.length > 512) throw new Error('invalid');
    return { displayContent, operations: parsed, diagnostics: [] };
  } catch {
    return {
      displayContent,
      operations: [],
      diagnostics: [{ source: 'scene-output-protocol', code: 'scene_patch_json_invalid', failures: [] }],
    };
  }
}

export function createGenerationService(options: {
  database: TavernDatabase;
  repositories: Repositories;
  providerClientFactory: ProviderClientFactory;
  promptSnapshotService?: PromptSnapshotService;
  tokenizerRuntime?: ServerTokenizerRuntime;
  sceneService?: SceneService;
  piAgentRuntimeFactory?: PiAgentRuntimeFactory;
  sceneDirectorLimits?: Partial<SceneDirectorLimits>;
}): SaveAgentRuntime {
  const { database, repositories, providerClientFactory } = options;
  const runtimeTokenizer = options.tokenizerRuntime ?? defaultTokenizerRuntime();
  const promptSnapshots = options.promptSnapshotService ?? createPromptSnapshotService({
    database,
    repositories,
    tokenizerRuntime: runtimeTokenizer,
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
    if (prepared.sceneDirector !== undefined) return prepared.sceneDirector.events(signal);
    const client = providerClientFactory(prepared.provider);
    return prepared.kind === 'chat'
      ? client.streamChat(prepared.request, signal)
      : client.streamText(prepared.request, signal);
  }

  async function* stream(prepared: PreparedGeneration, active: ActiveGeneration): AsyncIterable<SaveAgentRuntimeEvent> {
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
    let content = mode === 'continue' && variant !== undefined
      ? roleplayDocumentPlainText(variant.document)
      : '';
    const initialDocument: RoleplayDocument = mode === 'continue' && variant !== undefined
      ? structuredClone(variant.document)
      : roleplayDocumentFromMarkdown('');
    let document: RoleplayDocument = structuredClone(initialDocument);
    const initialContent = content;
    let reasoning = mode === 'continue' ? variant?.reasoning ?? '' : '';
    let hasDelta = false;
    let hasReasoningDelta = false;
    let finishReason = 'stop';
    let outcome: 'completed' | 'aborted' | 'failed' = 'aborted';
    let failureCode = 'upstream_error';
    let providerIterator: AsyncIterator<ProviderEvent> | undefined;
    const initialWorkspace = prepared.sceneDirector?.workspaceSnapshot();
    let sceneOperations = initialWorkspace?.operations ?? [...(prepared.sceneTransition?.beforeOperations ?? [])];
    let sceneFailures = initialWorkspace?.failures ?? [...(prepared.sceneTransition?.beforeFailures ?? [])];
    let sceneDiagnostics: SceneStateDiagnostic[] = [];
    let activeSceneId: string | undefined;

    const flush = (status: MessageVariant['status'] = 'streaming') => {
      if (variant === undefined) return;
      const updated = repositories.messageVariants.update(variant.id, variant.revision, {
        content,
        document,
        ...(reasoning === '' ? {} : { reasoning }),
        status,
        diagnostics: sceneDiagnostics,
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
            document,
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
            document,
          ...(reasoning === '' ? {} : { reasoning }),
          status: 'streaming',
          continuationBoundaries: [],
        });
      } else {
        flush();
      }
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
        activeSceneId = scene?.id;
        if (conversation !== undefined && scene !== undefined && state !== undefined) {
          const workspace = prepared.sceneDirector?.workspaceSnapshot();
          let nextState = workspace?.stateRevision === null || workspace === undefined
            ? prepared.sceneTransition === undefined
            ? state.value
            : applyScenePatchPartial(
              prepared.sceneTransition.baseValue,
              prepared.sceneTransition.beforeOperations,
              scene.manifest,
            ).value
            : workspace.stagedValue;
          if (scene.manifest.generationRecipe?.outputProtocol === 'mvu-json-patch-v1') {
            const protocol = sceneOutputProtocol(content);
            content = protocol.displayContent;
            sceneDiagnostics.push(...protocol.diagnostics);
            if (protocol.diagnostics.length === 0) {
              const applied = prepared.sceneDirector === undefined
                ? applyScenePatchPartial(nextState, protocol.operations, scene.manifest)
                : prepared.sceneDirector.stageWorkspacePatch(protocol.operations);
              nextState = applied.value;
              sceneOperations.push(...applied.operations);
              sceneFailures.push(...applied.failures);
            }
          }
          try {
            if (host !== undefined) {
              const processed = SceneAfterGenerationResultSchema.parse(await host.call('afterGeneration', {
                content, reasoning, state: nextState, setup: conversation.setup ?? {},
                playerProfile: conversation.playerProfile, manifest: scene.manifest,
              }));
              if (processed.displayContent !== undefined) content = processed.displayContent;
              if (processed.statePatch !== undefined) {
                const applied = prepared.sceneDirector === undefined
                  ? applyScenePatchPartial(nextState, processed.statePatch, scene.manifest)
                  : prepared.sceneDirector.stageWorkspacePatch(processed.statePatch);
                nextState = applied.value;
                sceneOperations.push(...applied.operations);
                sceneFailures.push(...applied.failures);
              }
            }
          } catch (error) {
            sceneDiagnostics.push({
              source: error instanceof SceneServiceError ? 'scene-output-protocol' : 'scene-hook',
              code: error instanceof SceneServiceError ? error.code : 'scene_hook_invalid',
              failures: [],
            });
          }
          if (prepared.sceneDirector !== undefined) {
            const finalizedWorkspace = prepared.sceneDirector.workspaceSnapshot();
            nextState = finalizedWorkspace.stagedValue;
            sceneOperations = finalizedWorkspace.operations;
            sceneFailures = finalizedWorkspace.failures;
          }
          if (sceneFailures.length > 0) {
            sceneDiagnostics.push({
              source: 'scene-output-protocol',
              code: 'scene_patch_partial_failure',
              appliedCount: sceneOperations.length,
              failures: sceneFailures,
            });
          }
        }
        if (prepared.sceneDirector !== undefined && content.trim() === '') {
          outcome = 'failed';
          failureCode = 'empty_narrative';
          hasDelta = false;
          hasReasoningDelta = false;
        }
      }
      if (outcome === 'completed' && prepared.sceneDirector !== undefined) {
        const resolved = await prepared.sceneDirector.resolveRoleplayDocument(content, controller.signal);
        if (controller.signal.aborted) {
          outcome = 'aborted';
        } else {
          document = resolved.document;
          content = roleplayDocumentPlainText(document);
          sceneDiagnostics.push(...resolved.diagnostics);
          if (content.trim() === '') {
            outcome = 'failed';
            failureCode = 'empty_narrative';
            hasDelta = false;
            hasReasoningDelta = false;
          }
        }
      } else {
        document = mode === 'continue'
          ? appendRoleplayMarkdown(initialDocument, content.slice(initialContent.length))
          : roleplayDocumentFromMarkdown(content);
        content = roleplayDocumentPlainText(document);
      }
      let agentTerminal: SceneDirectorTerminal | undefined;
      try {
        agentTerminal = await prepared.sceneDirector?.settle(
          outcome,
          outcome === 'completed' ? undefined : failureCode,
        );
      } catch {
        outcome = 'failed';
        failureCode = 'agent_audit_failed';
      }
      let completedDeferredSnapshot = false;
      try {
        database.transaction(() => {
          const persistResponse = prepared.sceneDirector === undefined || outcome === 'completed';
          if (outcome === 'completed' && prepared.sceneDirector !== undefined) {
            const workspace = prepared.sceneDirector.workspaceSnapshot();
            if (workspace.stateRevision !== null) {
              const current = repositories.conversationSceneStates.getByConversationId(prepared.conversationId);
              if (current === undefined || current.revision !== workspace.stateRevision) {
                throw new SceneServiceError('conflict', 409);
              }
            }
          }
          if (outcome === 'completed' && prepared.deferredSnapshotCommit === true) {
            promptSnapshots.commitDeferredSnapshot(prepared.generationId, prepared.payload);
            completedDeferredSnapshot = true;
          }
          if (persistResponse && variant === undefined && (hasDelta || hasReasoningDelta)) beginPersistence();
          if (persistResponse && variant !== undefined && (hasDelta || hasReasoningDelta)) flush(outcome);
          if (outcome === 'completed' && variant !== undefined && hasDelta && activeSceneId === undefined) {
            mvu.commitCompletedVariant(
              prepared.conversationId,
              variant.id,
              mode === 'continue' ? content.slice(initialContent.length) : content,
            );
          }
          if (outcome === 'completed' && variant !== undefined
            && prepared.sceneTransition !== undefined && sceneOperations.length > 0) {
            sceneService!.commitStateTransition(
              prepared.conversationId,
              prepared.sceneTransition.stateRevision,
              sceneOperations,
              {
                kind: 'message-variant',
                id: variant.id,
                parentTransitionId: prepared.sceneTransition.parentTransitionId,
                baseValue: prepared.sceneTransition.baseValue,
              },
            );
          }
          if (persistResponse && (hasDelta || hasReasoningDelta)) selectSibling();
          if (outcome === 'completed' && mode === 'normal') promptSnapshots.commitTimedState(prepared.payload);
          if (agentTerminal !== undefined) prepared.sceneDirector!.commitTerminal(agentTerminal);
        });
      } catch (error) {
        outcome = 'failed';
        failureCode = safeFailureCode(error);
        try {
          if (prepared.sceneDirector === undefined && (hasDelta || hasReasoningDelta)) {
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
        try {
          prepared.sceneDirector?.commitFailureAfterRollback(failureCode);
        } catch {
          failureCode = 'agent_audit_failed';
        }
      }
      if (prepared.deferredSnapshotCommit === true) {
        if (outcome === 'completed' && completedDeferredSnapshot) {
          promptSnapshots.completeDeferredSnapshot(prepared.generationId);
        } else {
          promptSnapshots.releaseDeferredSnapshot(prepared.generationId);
        }
        active.releaseDeferredSnapshot = undefined;
      }
      if (prepared.sceneDirector !== undefined && agentTerminal === undefined) {
        try {
          prepared.sceneDirector.commitFailureAfterRollback(failureCode);
        } catch {
          outcome = 'failed';
          failureCode = 'agent_audit_failed';
        }
      }
      active.cleanup();
    }

    if (outcome === 'completed') yield { type: 'completed', finishReason };
    else if (outcome === 'aborted') yield { type: 'aborted' };
    else yield { type: 'failed', code: failureCode };
  }

  function lifecycleEvents(
    prepared: PreparedGeneration,
    active: ActiveGeneration,
  ): AsyncIterableIterator<SaveAgentRuntimeEvent> {
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

  const service: SaveAgentRuntime = {
    async start(input: SaveAgentRunInput, signal?: AbortSignal): Promise<StartSaveAgentRunResult> {
      if (input.mode === 'normal' && (typeof input.userText !== 'string' || input.userText.trim() === '')) {
        return { ok: false, reason: 'invalid_user_text' };
      }
      if (input.mode !== 'normal' && input.userText !== undefined) return { ok: false, reason: 'invalid_user_text' };
      if (activeByConversation.has(input.conversationId)) return { ok: false, reason: 'generation_active' };
      const generationId = input.snapshotId ?? randomUUID();
      if (activeById.has(generationId)) return { ok: false, reason: 'generation_active' };
      const controller = new AbortController();
      const abortFromExternal = () => controller.abort(signal?.reason);
      if (signal?.aborted) abortFromExternal();
      else signal?.addEventListener('abort', abortFromExternal, { once: true });
      const active: ActiveGeneration = {
        generationId,
        conversationId: input.conversationId,
        controller,
        ...(signal === undefined ? {} : {
          detachExternalAbort: () => signal.removeEventListener('abort', abortFromExternal),
        }),
        state: 'reserved',
        cleanup() {
          if (active.state === 'closed') return;
          if (active.reservationTimer !== undefined) clearTimeout(active.reservationTimer);
          active.reservationTimer = undefined;
          active.detachExternalAbort?.();
          active.detachExternalAbort = undefined;
          active.releaseDeferredSnapshot?.();
          active.releaseDeferredSnapshot = undefined;
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
        let sceneTransition: PreparedGenerationBase['sceneTransition'];
        let scenePromptContext: Parameters<PromptSnapshotService['createAndAccept']>[2];
        let sceneAgentToolFactory: SceneAgentToolFactory | undefined;
        let sceneViewRuntimeFactory: SceneViewRuntimeFactory | undefined;
        if (sceneService !== undefined) {
          const conversation = repositories.conversations.get(input.conversationId);
          const scene = conversation?.sceneId === undefined ? undefined : sceneService.get(conversation.sceneId);
          const state = scene === undefined ? undefined : sceneService.state(input.conversationId);
          const host = scene === undefined ? undefined : sceneService.module(scene);
          if (conversation !== undefined && scene !== undefined && state !== undefined) {
            if (input.snapshotId !== undefined) throw new PromptSnapshotError('snapshot_mismatch');
            let baseValue = state.value;
            let parentTransitionId = state.headTransitionId;
            if (input.mode === 'swipe' || input.mode === 'regenerate') {
              const target = repositories.messages.listByConversationId(conversation.id).at(-1);
              const activeVariantId = target?.role === 'assistant' ? target.activeVariantId : null;
              const targetTransition = activeVariantId === null || activeVariantId === undefined
                ? undefined
                : repositories.sceneStateTransitions.getBySource('message-variant', activeVariantId);
              if (targetTransition !== undefined) {
                if (state.headTransitionId !== targetTransition.id) {
                  throw new SceneServiceError('scene_branch_has_descendants', 409);
                }
                parentTransitionId = targetTransition.parentTransitionId;
                baseValue = targetTransition.parentTransitionId === null
                  ? state.baseValue
                  : repositories.sceneStateTransitions.get(targetTransition.parentTransitionId)?.value ?? state.baseValue;
              }
            }
            const before = host === undefined
              ? SceneBeforeGenerationResultSchema.parse({})
              : SceneBeforeGenerationResultSchema.parse(await host.call('beforeGeneration', {
                state: baseValue, setup: conversation.setup ?? {}, playerProfile: conversation.playerProfile,
                manifest: scene.manifest, mode: input.mode, userText: input.userText,
              }));
            const beforeApplied = applyScenePatchPartial(baseValue, before.statePatch ?? [], scene.manifest);
            const beforeOperations = beforeApplied.operations;
            const stagedState = beforeApplied.value;
            sceneTransition = {
              stateRevision: state.revision,
              baseValue,
              parentTransitionId,
              beforeOperations,
              beforeFailures: beforeApplied.failures,
              stagedValue: stagedState,
              manifest: structuredClone(scene.manifest),
            };
            scenePromptContext = { state: stagedState, additions: before.promptAdditions ?? [] };
            sceneAgentToolFactory = createSceneAgentToolFactory({ scene, host, conversation });
            sceneViewRuntimeFactory = createSceneViewRuntimeFactory({ scene, host, conversation });
          }
        }
        let sceneDirector: SceneDirectorExecution | undefined;
        const beforeAccept = async (candidate: AcceptedPromptSnapshot) => {
          if (!candidate.provider.toolCalls) throw new PromptSnapshotError('model_not_agent_capable');
          if (input.mode !== 'normal' || candidate.payload.kind !== 'chat'
            || options.piAgentRuntimeFactory === undefined) return undefined;
          const configurationRef = candidate.payload.entityRevisions.saveAgentConfiguration;
          const configuration = candidate.saveAgentConfiguration;
          if (configurationRef === undefined || configurationRef === null || configuration === undefined
            || configuration.id !== configurationRef.id || configuration.revision !== configurationRef.revision) {
            throw new PromptSnapshotError('snapshot_unsupported');
          }
          const execution = new SceneDirectorExecution({
            repositories,
            generationId,
            snapshotId: candidate.snapshotId,
            payload: candidate.payload,
            provider: candidate.provider,
            configuration,
            runtimeFactory: options.piAgentRuntimeFactory,
            ...(options.sceneDirectorLimits === undefined ? {} : { limits: options.sceneDirectorLimits }),
            ...(sceneTransition === undefined ? {} : { effectiveSceneState: sceneTransition.stagedValue }),
            ...(scenePromptContext?.additions === undefined ? {} : {
              scenePromptAdditions: scenePromptContext.additions,
            }),
            ...(sceneTransition === undefined ? {} : {
              workspaceState: {
                revision: sceneTransition.stateRevision,
                value: sceneTransition.baseValue,
                manifest: sceneTransition.manifest,
                initialOperations: sceneTransition.beforeOperations,
                initialFailures: sceneTransition.beforeFailures,
              },
            }),
            ...(sceneAgentToolFactory === undefined ? {} : { sceneAgentToolFactory }),
            ...(sceneViewRuntimeFactory === undefined ? {} : { sceneViewRuntimeFactory }),
          });
          await execution.validatePromptBudget(runtimeTokenizer);
          sceneDirector = execution;
          return { deferSnapshotCommit: true as const };
        };
        const accepted = input.snapshotId === undefined
          ? await promptSnapshots.createAndAccept(input, generationId, scenePromptContext, beforeAccept)
          : await promptSnapshots.acceptExisting({ ...input, snapshotId: input.snapshotId }, beforeAccept);
        if (accepted.deferredSnapshotCommit === true) {
          active.releaseDeferredSnapshot = () => promptSnapshots.releaseDeferredSnapshot(generationId);
        }
        // Retain defensive validation for injected PromptSnapshotService implementations that
        // predate the pre-accept hook, while production acceptance always invokes the hook.
        if (!accepted.provider.toolCalls) throw new PromptSnapshotError('model_not_agent_capable');
        const prepared = preparedRequest(
          generationId,
          accepted.provider,
          accepted.payload,
          reasoningCompatibility.resolve(accepted.payload),
          sceneTransition,
        );
        if (input.mode === 'normal' && accepted.payload.kind === 'chat'
          && options.piAgentRuntimeFactory !== undefined && sceneDirector === undefined) {
          const configurationRef = accepted.payload.entityRevisions.saveAgentConfiguration;
          const configuration = accepted.saveAgentConfiguration;
          if (configurationRef === undefined || configurationRef === null || configuration === undefined
            || configuration.id !== configurationRef.id || configuration.revision !== configurationRef.revision) {
            throw new PromptSnapshotError('snapshot_unsupported');
          }
          const execution = new SceneDirectorExecution({
            repositories,
            generationId,
            snapshotId: accepted.snapshotId,
            payload: accepted.payload,
            provider: accepted.provider,
            configuration,
            runtimeFactory: options.piAgentRuntimeFactory,
            ...(options.sceneDirectorLimits === undefined ? {} : { limits: options.sceneDirectorLimits }),
            ...(sceneTransition === undefined ? {} : { effectiveSceneState: sceneTransition.stagedValue }),
            ...(scenePromptContext?.additions === undefined ? {} : {
              scenePromptAdditions: scenePromptContext.additions,
            }),
            ...(sceneTransition === undefined ? {} : {
              workspaceState: {
                revision: sceneTransition.stateRevision,
                value: sceneTransition.baseValue,
                manifest: sceneTransition.manifest,
                initialOperations: sceneTransition.beforeOperations,
                initialFailures: sceneTransition.beforeFailures,
              },
            }),
            ...(sceneAgentToolFactory === undefined ? {} : { sceneAgentToolFactory }),
            ...(sceneViewRuntimeFactory === undefined ? {} : { sceneViewRuntimeFactory }),
          });
          await execution.validatePromptBudget(runtimeTokenizer);
          sceneDirector = execution;
        }
        if (sceneDirector !== undefined) prepared.sceneDirector = sceneDirector;
        if (accepted.deferredSnapshotCommit === true) {
          prepared.deferredSnapshotCommit = true;
        }
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
        if (error instanceof SceneServiceError) return { ok: false, reason: 'invalid_runtime_state' };
        throw error;
      }
    },
    async triggerLastUser(conversationId, signal) {
      if (activeByConversation.has(conversationId)) return { ok: false, reason: 'generation_active' };
      const conversation = repositories.conversations.get(conversationId);
      if (conversation === undefined) return { ok: false, reason: 'not_found' };
      const last = repositories.messages.listByConversationId(conversationId).at(-1);
      if (last?.role !== 'user' || last.content.trim() === '') return { ok: false, reason: 'invalid_user_text' };
      return service.start({
        conversationId, conversationRevision: conversation.revision,
        mode: 'normal', userText: last.content, reuseLastUser: true,
      }, signal);
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
