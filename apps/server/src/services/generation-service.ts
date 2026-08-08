import { randomUUID } from 'node:crypto';
import type { GenerationMode, MessageVariant, ProviderProfile } from '@tavernnext/domain';
import type { ChatRequest, OpenAICompatibleClient } from '@tavernnext/provider-openai-compatible';
import { ProviderError } from '@tavernnext/provider-openai-compatible';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { compileBasicChat, type MessageWithActiveVariant } from './basic-prompt.js';

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
}

export type ProviderClientFactory = (profile: ProviderProfile) => OpenAICompatibleClient;

export type StartGenerationResult =
  | { ok: true; generationId: string; events: AsyncIterable<GenerationEvent> }
  | { ok: false; reason: 'generation_active' | 'not_found' | 'revision_conflict' | 'provider_not_configured' | 'unsupported_mode' };

interface ActiveGeneration {
  conversationId: string;
  controller: AbortController;
}

interface PreparedGeneration {
  generationId: string;
  conversationId: string;
  provider: ProviderProfile;
  request: ChatRequest;
}

export interface GenerationService {
  start(input: GenerationInput): StartGenerationResult;
  cancel(generationId: string): boolean;
}

function historyFor(repositories: Repositories, conversationId: string): MessageWithActiveVariant[] {
  const variants = new Map(repositories.messageVariants.list().map((variant) => [variant.id, variant]));
  return repositories.messages.list()
    .filter((message) => message.conversationId === conversationId)
    .map((message) => ({
      message,
      ...(message.activeVariantId === null ? {} : { activeVariant: variants.get(message.activeVariantId) }),
    }));
}

function safeFailureCode(error: unknown): string {
  return error instanceof ProviderError ? error.code : 'upstream_error';
}

export function createGenerationService(options: {
  database: TavernDatabase;
  repositories: Repositories;
  providerClientFactory: ProviderClientFactory;
}): GenerationService {
  const { database, repositories, providerClientFactory } = options;
  const activeByConversation = new Map<string, string>();
  const activeById = new Map<string, ActiveGeneration>();

  function prepare(input: GenerationInput, generationId: string): PreparedGeneration | StartGenerationResult {
    const prepared = database.transaction(() => {
      const conversation = repositories.conversations.get(input.conversationId);
      if (conversation === undefined) return { ok: false as const, reason: 'not_found' as const };
      if (conversation.revision !== input.conversationRevision) {
        return { ok: false as const, reason: 'revision_conflict' as const };
      }
      const character = repositories.characters.get(conversation.characterId);
      const persona = repositories.personas.get(conversation.personaId);
      if (character === undefined || persona === undefined) return { ok: false as const, reason: 'not_found' as const };
      const provider = repositories.providerProfiles.list()[0];
      if (provider === undefined) return { ok: false as const, reason: 'provider_not_configured' as const };

      if (input.userText !== undefined && input.userText !== '') {
        repositories.messages.create({
          id: randomUUID(),
          conversationId: conversation.id,
          role: 'user',
          content: input.userText,
          activeVariantId: null,
        });
        const revision = repositories.conversations.update(conversation.id, input.conversationRevision, {});
        if (!revision.ok) return { ok: false as const, reason: 'revision_conflict' as const };
      }

      repositories.generationSnapshots.create({
        id: generationId,
        conversationId: conversation.id,
        conversationRevision: input.conversationRevision,
        payload: {
          conversation: { id: conversation.id, revision: conversation.revision },
          character: { id: character.id, revision: character.revision },
          persona: { id: persona.id, revision: persona.revision },
          provider: { id: provider.id, revision: provider.revision },
        },
      });

      return {
        generationId,
        conversationId: conversation.id,
        provider,
        request: {
          model: provider.model,
          messages: compileBasicChat({ character, persona, history: historyFor(repositories, conversation.id) }),
        },
      } satisfies PreparedGeneration;
    });
    return prepared;
  }

  async function* stream(prepared: PreparedGeneration, controller: AbortController): AsyncIterable<GenerationEvent> {
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
      const client = providerClientFactory(prepared.provider);
      for await (const event of client.streamChat(prepared.request, controller.signal)) {
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
      } catch (error) {
        outcome = 'failed';
        failureCode = safeFailureCode(error);
      }
      activeByConversation.delete(prepared.conversationId);
      activeById.delete(prepared.generationId);
    }

    if (outcome === 'completed') yield { type: 'completed', finishReason };
    else if (outcome === 'aborted') yield { type: 'aborted' };
    else yield { type: 'failed', code: failureCode };
  }

  return {
    start(input) {
      if (input.mode !== 'normal') return { ok: false, reason: 'unsupported_mode' };
      if (activeByConversation.has(input.conversationId)) return { ok: false, reason: 'generation_active' };
      const generationId = randomUUID();
      activeByConversation.set(input.conversationId, generationId);
      const controller = new AbortController();
      activeById.set(generationId, { conversationId: input.conversationId, controller });
      try {
        const prepared = prepare(input, generationId);
        if ('ok' in prepared) {
          activeByConversation.delete(input.conversationId);
          activeById.delete(generationId);
          return prepared;
        }
        return { ok: true, generationId, events: stream(prepared, controller) };
      } catch (error) {
        activeByConversation.delete(input.conversationId);
        activeById.delete(generationId);
        throw error;
      }
    },
    cancel(generationId) {
      const active = activeById.get(generationId);
      if (active === undefined) return false;
      active.controller.abort();
      return true;
    },
  };
}
