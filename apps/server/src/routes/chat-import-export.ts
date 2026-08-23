import { Readable } from 'node:stream';
import {
  StChatCodecError,
  streamStChatJsonl,
  type StChatDocument,
  type StChatHeader,
  type StChatMessage,
  type StChatVariant,
} from '@tavernnext/st-compat';
import type { Message, MessageVariant } from '@tavernnext/domain';
import type { FastifyInstance } from 'fastify';
import { RelationshipLimitError, type Repositories } from '../db/repositories.js';
import { ChatImportError } from '../services/chat-import-handler.js';
import { ImportCommitError, ImportTokenError, type ImportService } from '../services/import-service.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourcePayload(value: { compatibility?: { rawPayload: unknown } }): Record<string, unknown> {
  return record(value.compatibility?.rawPayload) ? structuredClone(value.compatibility.rawPayload) : {};
}

function sourceRecord(value: unknown): Record<string, unknown> {
  return record(value) ? structuredClone(value) : {};
}

const runtimeStateKey = 'tavernnext_runtime_state';

function defined<T>(current: T | undefined, fallback: unknown): T | undefined {
  return current === undefined ? fallback as T | undefined : current;
}

function exportVariant(row: MessageVariant, repositories: Repositories): StChatVariant {
  const source = sourcePayload(row);
  const runtimeState = repositories.extensionStates.getByScope('message-variant', row.id);
  return {
    ordinal: row.ordinal,
    content: row.content,
    ...(defined(row.sendDate, source.sendDate) === undefined ? {} : { sendDate: defined(row.sendDate, source.sendDate)! }),
    ...(defined(row.generationStarted, source.generationStarted) === undefined
      ? {} : { generationStarted: defined(row.generationStarted, source.generationStarted)! }),
    ...(defined(row.generationFinished, source.generationFinished) === undefined
      ? {} : { generationFinished: defined(row.generationFinished, source.generationFinished)! }),
    ...(defined(row.api, source.api) === undefined ? {} : { api: defined(row.api, source.api)! }),
    ...(defined(row.model, source.model) === undefined ? {} : { model: defined(row.model, source.model)! }),
    ...(defined(row.tokenCount, source.tokenCount) === undefined ? {} : { tokenCount: defined(row.tokenCount, source.tokenCount)! }),
    ...(defined(row.reasoning, source.reasoning) === undefined ? {} : { reasoning: defined(row.reasoning, source.reasoning)! }),
    ...(defined(row.reasoningDuration, source.reasoningDuration) === undefined
      ? {} : { reasoningDuration: defined(row.reasoningDuration, source.reasoningDuration)! }),
    extra: sourceRecord(source.extra),
    swipeInfo: {
      ...sourceRecord(source.swipeInfo),
      ...(runtimeState === undefined ? {} : { [runtimeStateKey]: structuredClone(runtimeState.value) }),
    },
  };
}

function fallbackVariant(message: Message): StChatVariant {
  return { ordinal: 0, content: message.content, extra: {}, swipeInfo: {} };
}

function exportMessage(
  message: Message,
  variants: MessageVariant[],
  header: StChatHeader,
  repositories: Repositories,
): StChatMessage {
  const source = sourcePayload(message);
  const orderedVariants = [...variants].sort((left, right) => left.ordinal - right.ordinal
    || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const exportedVariants = orderedVariants.length === 0
    ? [fallbackVariant(message)]
    : orderedVariants.map((variant) => exportVariant(variant, repositories));
  const selected = message.activeVariantId === null
    ? -1
    : orderedVariants.findIndex((variant) => variant.id === message.activeVariantId);
  const activeVariantIndex = selected >= 0 ? selected : 0;
  const active = exportedVariants[activeVariantIndex]!;
  if (message.role !== 'assistant') active.content = message.content;
  return {
    role: message.role,
    isSystem: message.role === 'system' ? source.isSystem !== false : false,
    name: typeof source.name === 'string'
      ? source.name
      : message.role === 'user' ? header.userName : message.role === 'assistant' ? header.characterName : 'System',
    content: active.content,
    activeVariantIndex,
    hadExplicitSwipes: source.hadExplicitSwipes === true || exportedVariants.length > 1,
    variants: exportedVariants,
    extra: sourceRecord(source.extra),
    raw: sourceRecord(source.raw),
  };
}

function exportDocument(repositories: Repositories, conversationId: string): { document: StChatDocument; title: string } | undefined {
  const conversation = repositories.conversations.get(conversationId);
  if (conversation === undefined) return undefined;
  const character = repositories.characters.get(conversation.characterId);
  const persona = repositories.personas.get(conversation.personaId);
  if (character === undefined || persona === undefined) return undefined;
  const source = sourcePayload(conversation);
  const conversationState = repositories.extensionStates.getByScope('conversation', conversation.id);
  const header: StChatHeader = {
    userName: persona.name,
    characterName: character.name,
    ...(typeof source.createDate === 'string' || typeof source.createDate === 'number'
      ? { createDate: source.createDate } : {}),
    chatMetadata: {
      ...sourceRecord(source.chatMetadata),
      ...(conversationState === undefined ? {} : { [runtimeStateKey]: structuredClone(conversationState.value) }),
    },
    raw: sourceRecord(source.raw),
  };
  const variantRows = repositories.messageVariants.listByConversationId(conversation.id);
  const variantsByMessage = new Map<string, MessageVariant[]>();
  for (const variant of variantRows) {
    const current = variantsByMessage.get(variant.messageId) ?? [];
    current.push(variant);
    variantsByMessage.set(variant.messageId, current);
  }
  const messages = repositories.messages.listByConversationId(conversation.id)
    .map((message) => exportMessage(message, variantsByMessage.get(message.id) ?? [], header, repositories));
  return { document: { header, messages }, title: conversation.title };
}

function wellFormedUnicode(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        result += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd';
    } else {
      result += value[index]!;
    }
  }
  return result;
}

function safeExportName(title: string): string {
  const sanitized = wellFormedUnicode(title).replace(/[\u0000-\u001f\u007f/\\]/g, '_');
  const base = Array.from(sanitized).slice(0, 200).join('') || 'chat';
  return `${base}.jsonl`;
}

function rfc5987(value: string): string {
  return encodeURIComponent(wellFormedUnicode(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function registerChatImportExportRoutes(
  app: FastifyInstance,
  imports: ImportService,
  repositories: Repositories,
): void {
  app.post('/api/chats/imports/commit', async (request, reply) => {
    const body = request.body;
    const token = record(body) ? body.inspectionToken : undefined;
    if (typeof token !== 'string' || token === '') {
      return reply.code(400).send({ error: 'inspection_token_required' });
    }
    try {
      return reply.code(201).send(imports.commit(token, body));
    } catch (error) {
      if (error instanceof ImportTokenError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof ImportCommitError && error.causeError instanceof ChatImportError) {
        return reply.code(error.causeError.statusCode).send({ error: error.causeError.code });
      }
      if (error instanceof ImportCommitError && error.causeError instanceof StChatCodecError) {
        return reply.code(422).send({ error: error.causeError.code });
      }
      if (error instanceof ImportCommitError && error.code === 'runtime_state_limit') {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      if (error instanceof ImportCommitError) return reply.code(500).send({ error: 'import_commit_failed' });
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/conversations/:id/export',
    async (request, reply) => {
      if (request.query.format !== 'st-jsonl') return reply.code(400).send({ error: 'unsupported_export_format' });
      try {
        const source = exportDocument(repositories, request.params.id);
        if (source === undefined) return reply.code(404).send({ error: 'not_found' });
        const artifact = streamStChatJsonl(source.document, safeExportName(source.title));
        reply.header('content-type', artifact.contentType);
        reply.header('content-disposition', `attachment; filename="chat.jsonl"; filename*=UTF-8''${rfc5987(artifact.fileName)}`);
        return reply.send(Readable.from(artifact.chunks));
      } catch (error) {
        if (error instanceof RelationshipLimitError) return reply.code(422).send({ error: error.code });
        if (error instanceof StChatCodecError) return reply.code(422).send({ error: error.code });
        throw error;
      }
    },
  );
}
