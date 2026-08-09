import { randomUUID } from 'node:crypto';
import {
  decodeStChatJsonl,
  inspectStChatJsonl,
  type StChatDocument,
  type StChatMessage,
  type StChatVariant,
} from '@tavernnext/st-compat';
import type { CompatibilityMetadata } from '@tavernnext/domain';
import type { ImportCommitContext, ImportHandler } from './import-service.js';

interface ChatImportOptions {
  characterId: string;
  personaId: string;
  title: string;
}

export class ChatImportError extends Error {
  constructor(
    readonly code: 'chat_import_target_required' | 'chat_import_target_not_found' | 'chat_import_title_invalid',
    readonly statusCode: 400 | 404,
  ) {
    super(code);
    this.name = 'ChatImportError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionsFrom(value: unknown): ChatImportOptions {
  if (!record(value) || typeof value.characterId !== 'string' || typeof value.personaId !== 'string') {
    throw new ChatImportError('chat_import_target_required', 400);
  }
  if (typeof value.title !== 'string' || value.title.trim() === '' || value.title.length > 512) {
    throw new ChatImportError('chat_import_title_invalid', 400);
  }
  return { characterId: value.characterId, personaId: value.personaId, title: value.title.trim() };
}

function compatibility(rawPayload: unknown, unknownFields: Record<string, unknown>): CompatibilityMetadata {
  return {
    sourceFormat: 'sillytavern-chat-jsonl',
    rawPayload: structuredClone(rawPayload),
    unknownFields: structuredClone(unknownFields),
    compatWarnings: [],
    parserVersion: '1',
  };
}

function safePreview(chat: StChatDocument): unknown {
  return {
    header: {
      userName: chat.header.userName,
      characterName: chat.header.characterName,
      ...(chat.header.createDate === undefined ? {} : { createDate: chat.header.createDate }),
    },
    messages: chat.messages.map((message) => ({
      role: message.role,
      name: message.name,
      content: message.content,
      activeVariantIndex: message.activeVariantIndex,
      variants: message.variants.map((variant) => ({ ordinal: variant.ordinal, content: variant.content })),
    })),
  };
}

function variantInput(id: string, messageId: string, variant: StChatVariant) {
  return {
    id,
    messageId,
    ordinal: variant.ordinal,
    content: variant.content,
    status: 'completed' as const,
    continuationBoundaries: [],
    ...(variant.sendDate === undefined ? {} : { sendDate: variant.sendDate }),
    ...(variant.generationStarted === undefined ? {} : { generationStarted: variant.generationStarted }),
    ...(variant.generationFinished === undefined ? {} : { generationFinished: variant.generationFinished }),
    ...(variant.api === undefined ? {} : { api: variant.api }),
    ...(variant.model === undefined ? {} : { model: variant.model }),
    ...(variant.tokenCount === undefined ? {} : { tokenCount: variant.tokenCount }),
    ...(variant.reasoning === undefined ? {} : { reasoning: variant.reasoning }),
    ...(variant.reasoningDuration === undefined ? {} : { reasoningDuration: variant.reasoningDuration }),
    compatibility: compatibility(variant, variant.swipeInfo),
  };
}

function createMessage(context: ImportCommitContext, id: string, conversationId: string, source: StChatMessage): void {
  const message = context.repositories.messages.create({
    id,
    conversationId,
    role: source.role,
    content: source.content,
    activeVariantId: null,
    compatibility: compatibility({
      name: source.name,
      isSystem: source.isSystem,
      hadExplicitSwipes: source.hadExplicitSwipes,
      extra: source.extra,
      raw: source.raw,
    }, source.raw),
  });
  const variantIds = source.variants.map(() => randomUUID()).sort();
  const variants = source.variants.map((variant, index) => (
    context.repositories.messageVariants.create(variantInput(variantIds[index]!, message.id, variant))
  ));
  const active = variants[source.activeVariantIndex];
  if (active === undefined) throw new Error('Imported chat active variant is not aligned.');
  const linked = context.repositories.messages.update(message.id, message.revision, { activeVariantId: active.id });
  if (!linked.ok) throw new Error(`Unable to link imported chat variant: ${linked.reason}`);
}

export function createChatImportHandler(): ImportHandler {
  return {
    id: 'sillytavern-chat-jsonl',
    matches(preview) {
      return preview.detected.container === 'jsonl' && preview.detected.kind === 'chat';
    },
    async inspect({ artifact }) {
      const inspected = inspectStChatJsonl(artifact.bytes, artifact.fileName);
      return {
        normalizedPreview: inspected.normalizedPreview === null ? null : safePreview(inspected.normalizedPreview),
        warnings: inspected.warnings,
        blockingErrors: inspected.blockingErrors,
      };
    },
    commit(context) {
      const options = optionsFrom(context.commitOptions);
      const character = context.repositories.characters.get(options.characterId);
      const persona = context.repositories.personas.get(options.personaId);
      if (character === undefined || persona === undefined) {
        throw new ChatImportError('chat_import_target_not_found', 404);
      }
      const chat = decodeStChatJsonl(context.artifact.bytes);
      const conversation = context.repositories.conversations.create({
        id: randomUUID(),
        characterId: character.id,
        personaId: persona.id,
        title: options.title,
        compatibility: compatibility(chat.header, chat.header.raw),
      });
      const messageIds = chat.messages.map(() => randomUUID()).sort();
      for (const [index, message] of chat.messages.entries()) {
        createMessage(context, messageIds[index]!, conversation.id, message);
      }
      return { entityId: conversation.id };
    },
  };
}
