import { randomUUID } from 'node:crypto';
import {
  ExtensionOwnerKindSchema,
  ExtensionStateScopeSchema,
  roleplayDocumentFromMarkdown,
  roleplayDocumentPlainText,
  type ExtensionStateScope,
} from '@tavernnext/domain';
import {
  GENERATION_BLOCKED_TAVERN_HELPER_METHODS,
  TavernRegexSchema,
  type ExtensionRuntimeRpcEnvelope,
} from '@tavernnext/extension-runtime';
import { overlayAttachedExtensionAssets } from '@tavernnext/st-compat';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { assertRuntimeStateValue } from '../runtime-state-validation.js';
import { resolveActiveResourceContext } from './active-extension-resources.js';
import type { SaveAgentRuntime } from './save-agent-runtime.js';
import type { createExtensionTrustService } from './extension-trust-service.js';

type TrustService = ReturnType<typeof createExtensionTrustService>;

export class RpcError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 422) { super(code); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function messageView(repositories: Repositories, conversationId: string) {
  const messages = repositories.messages.listByConversationId(conversationId);
  const variants = new Map(repositories.messageVariants.listByConversationId(conversationId).map((value) => [value.id, value]));
  return messages.map((message, messageId) => {
    const active = message.activeVariantId === null ? undefined : variants.get(message.activeVariantId);
    return {
      message_id: messageId,
      id: message.id,
      revision: message.revision,
      role: message.role,
      message: message.role === 'assistant' && active !== undefined
        ? roleplayDocumentPlainText(active.document)
        : message.content,
      active_variant_id: active?.id ?? null,
      active_variant_revision: active?.revision ?? null,
    };
  });
}

export function createExtensionRuntimeRpcService(
  database: TavernDatabase,
  repositories: Repositories,
  generations: SaveAgentRuntime,
  trust: TrustService,
) {
  return {
    async execute(conversationId: string, input: ExtensionRuntimeRpcEnvelope): Promise<unknown> {
      const context = resolveActiveResourceContext(repositories, conversationId);
      if (context.conversation === null) throw new RpcError('not_found', 404);
      const owner = context.owners.find((candidate) => candidate.kind === input.ownerKind && candidate.id === input.ownerId);
      if (owner === undefined) throw new RpcError('runtime_not_authorized', 403);
      if (owner.revision !== input.ownerRevision) throw new RpcError('stale_runtime', 409);
      const review = trust.review(input.ownerKind, input.ownerId);
      if (review.bundleDigest !== input.bundleDigest) throw new RpcError('stale_runtime', 409);
      if (!review.trusted || !review.scripts.some((script) => script.enabled && script.sourceKey === input.scriptId)) {
        throw new RpcError('runtime_not_authorized', 403);
      }
      if (generations.isConversationActive(conversationId)
        && GENERATION_BLOCKED_TAVERN_HELPER_METHODS.has(input.method)) {
        throw new RpcError('generation_active', 409);
      }

      const resolveScope = (scopeValue: unknown, scopeIdValue: unknown): { scope: ExtensionStateScope; scopeId: string } => {
        const scope = ExtensionStateScopeSchema.safeParse(scopeValue ?? 'script');
        if (!scope.success) throw new RpcError('invalid_scope', 400);
        const scopeId = (() => {
          if (scope.data === 'global') return 'global';
          if (scope.data === 'character') return context.character?.id;
          if (scope.data === 'preset') return context.primaryPreset?.id;
          if (scope.data === 'conversation') return context.conversation?.id;
          if (scope.data === 'script') return `${input.ownerKind}:${input.ownerId}:${input.scriptId}`;
          return typeof scopeIdValue === 'string' ? scopeIdValue : undefined;
        })();
        if (scopeId === undefined) throw new RpcError('scope_owner_not_found', 404);
        if (scope.data === 'message-variant') {
          const variant = repositories.messageVariants.get(scopeId);
          const message = variant === undefined ? undefined : repositories.messages.get(variant.messageId);
          if (message?.conversationId !== conversationId) throw new RpcError('runtime_not_authorized', 403);
        }
        return { scope: scope.data, scopeId };
      };
      const stateView = ({ scope, scopeId }: { scope: ExtensionStateScope; scopeId: string }) => {
        const state = repositories.extensionStates.getByScope(scope, scopeId);
        return { scope, scopeId, revision: state?.revision ?? null, value: structuredClone(state?.value ?? {}) };
      };
      const replaceState = (args: unknown[]) => {
        const value = record(args[0]);
        if (value === undefined) throw new RpcError('invalid_request', 400);
        assertRuntimeStateValue(value);
        const identity = resolveScope(args[1], args[2]);
        const expected = args[3] === null || Number.isInteger(args[3]) ? args[3] as number | null : undefined;
        return database.transaction(() => {
          const current = repositories.extensionStates.getByScope(identity.scope, identity.scopeId);
          if (expected !== undefined && expected !== (current?.revision ?? null)) throw new RpcError('conflict', 409);
          if (current === undefined) repositories.extensionStates.create({ id: randomUUID(), ...identity, value: structuredClone(value) });
          else {
            const updated = repositories.extensionStates.update(current.id, current.revision, { value: structuredClone(value) });
            if (!updated.ok) throw new RpcError('conflict', 409);
          }
          return stateView(identity);
        });
      };
      const mutateState = (args: unknown[], operation: 'merge' | 'insert' | 'delete') => {
        const identity = resolveScope(args[1], args[2]);
        const current = repositories.extensionStates.getByScope(identity.scope, identity.scopeId);
        const expected = args[3] === null || Number.isInteger(args[3]) ? args[3] as number | null : undefined;
        if (expected !== undefined && expected !== (current?.revision ?? null)) throw new RpcError('conflict', 409);
        const prior = structuredClone(current?.value ?? {});
        if (operation === 'delete') {
          const key = args[0];
          if (typeof key !== 'string') throw new RpcError('invalid_request', 400);
          delete prior[key];
        } else {
          const patch = record(args[0]);
          if (patch === undefined) throw new RpcError('invalid_request', 400);
          for (const [key, nested] of Object.entries(patch)) {
            if (operation === 'merge' || !Object.hasOwn(prior, key)) prior[key] = structuredClone(nested);
          }
        }
        assertRuntimeStateValue(prior);
        return replaceState([prior, identity.scope, identity.scopeId, current?.revision ?? null]);
      };
      const macroValues = () => ({
        user: repositories.personas.get(repositories.conversations.get(conversationId)!.personaId)?.name ?? '',
        char: context.character?.name ?? '',
        model: (() => {
          const config = repositories.globalGenerationConfig.get();
          return config.providerId === null ? '' : repositories.providerProfiles.get(config.providerId)?.model ?? '';
        })(),
        description: context.character === null ? '' : repositories.characters.get(context.character.id)?.description ?? '',
        personality: context.character === null ? '' : repositories.characters.get(context.character.id)?.personality ?? '',
        scenario: context.character === null ? '' : repositories.characters.get(context.character.id)?.scenario ?? '',
        persona: repositories.personas.get(repositories.conversations.get(conversationId)!.personaId)?.description ?? '',
      });
      const substituteMacros = (text: string) => text.replace(/\{\{([^{}]+)\}\}/g, (whole, key: string) => (
        macroValues()[key.trim() as keyof ReturnType<typeof macroValues>] ?? whole
      ));
      const targetOwner = (kindValue: unknown) => {
        const kind = kindValue === undefined ? input.ownerKind : ExtensionOwnerKindSchema.parse(kindValue);
        const activeOwner = context.owners.find((owner) => owner.kind === kind);
        if (activeOwner === undefined) throw new RpcError('runtime_not_authorized', 403);
        const entity = kind === 'character' ? repositories.characters.get(activeOwner.id) : repositories.presets.get(activeOwner.id);
        if (entity === undefined) throw new RpcError('not_found', 404);
        return { kind, entity };
      };

      const value = await (async () => {
        if (input.method === 'generate' || input.method === 'generateRaw' || input.method === 'triggerSlash') {
          const raw = input.args[0];
          const object = record(raw);
          const supplied = typeof raw === 'string'
            ? raw
            : typeof object?.prompt === 'string' ? object.prompt
              : typeof object?.user_input === 'string' ? object.user_input : undefined;
          const prompt = input.method === 'triggerSlash' && supplied?.startsWith('/trigger')
            ? supplied.slice('/trigger'.length).trim()
            : supplied;
          if (prompt === undefined) throw new RpcError('invalid_request', 400);
          const conversation = repositories.conversations.get(conversationId);
          if (conversation === undefined) throw new RpcError('not_found', 404);
          const started = input.method === 'triggerSlash' && prompt === ''
            ? await generations.triggerLastUser(conversationId)
            : await generations.start({
              conversationId, conversationRevision: conversation.revision, mode: 'normal', userText: prompt,
            });
          if (!started.ok) throw new RpcError(started.reason, started.reason === 'generation_active' ? 409 : 422);
          let output = '';
          for await (const event of started.events) {
            if (event.type === 'delta') output += event.text;
            if (event.type === 'failed') throw new RpcError(event.code, 422);
          }
          return output;
        }
        if (input.method === 'getChatMessages') return messageView(repositories, conversationId);
        if (input.method === 'getLastMessageId') return messageView(repositories, conversationId).length - 1;
        if (input.method === 'setChatMessages') {
          const updates = Array.isArray(input.args[0]) ? input.args[0] : undefined;
          if (updates === undefined) throw new RpcError('invalid_request', 400);
          database.transaction(() => {
            for (const candidate of updates) {
              const update = record(candidate);
              const index = update?.message_id;
              const content = update?.message;
              const expected = update?.expected_revision;
              const rows = messageView(repositories, conversationId);
              const row = typeof index === 'number' && Number.isInteger(index) ? rows[index] : undefined;
              if (row === undefined || typeof content !== 'string') throw new RpcError('invalid_request', 400);
              if (expected !== undefined && expected !== row.revision) throw new RpcError('conflict', 409);
              const updated = repositories.messages.update(row.id, row.revision, { content });
              if (!updated.ok) throw new RpcError('conflict', 409);
              if (row.active_variant_id !== null) {
                const expectedVariant = update?.expected_variant_revision;
                if (expectedVariant !== undefined && expectedVariant !== row.active_variant_revision) throw new RpcError('conflict', 409);
                const variant = repositories.messageVariants.update(row.active_variant_id, row.active_variant_revision!, {
                  content,
                  document: roleplayDocumentFromMarkdown(content),
                });
                if (!variant.ok) throw new RpcError('conflict', 409);
              }
            }
          });
          return messageView(repositories, conversationId);
        }
        if (input.method === 'createChatMessages') {
          const items = Array.isArray(input.args[0]) ? input.args[0] : undefined;
          if (items === undefined) throw new RpcError('invalid_request', 400);
          database.transaction(() => {
            for (const candidate of items) {
              const item = record(candidate);
              const role = item?.role;
              const content = item?.message;
              if (!['system', 'user', 'assistant'].includes(String(role)) || typeof content !== 'string') throw new RpcError('invalid_request', 400);
              const message = repositories.messages.create({
                id: randomUUID(), conversationId: conversationId,
                role: role as 'system' | 'user' | 'assistant', content, activeVariantId: null,
              });
              if (role === 'assistant') {
                const variant = repositories.messageVariants.create({
                  id: randomUUID(), messageId: message.id, content, status: 'completed', finishReason: 'script',
                });
                const linked = repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id });
                if (!linked.ok) throw new RpcError('conflict', 409);
              }
            }
          });
          return messageView(repositories, conversationId);
        }
        if (input.method === 'deleteChatMessages') {
          const indices = Array.isArray(input.args[0]) ? input.args[0] : undefined;
          if (indices === undefined || !indices.every((index) => Number.isInteger(index))) throw new RpcError('invalid_request', 400);
          database.transaction(() => {
            const rows = messageView(repositories, conversationId);
            for (const index of [...indices as number[]].sort((left, right) => right - left)) {
              const row = rows[index];
              if (row === undefined) throw new RpcError('invalid_request', 400);
              for (const variant of repositories.messageVariants.listByMessageId(row.id)) {
                repositories.extensionStates.deleteByScope('message-variant', variant.id);
              }
              const removed = repositories.messages.delete(row.id, row.revision);
              if (!removed.ok) throw new RpcError('conflict', 409);
            }
          });
          return messageView(repositories, conversationId);
        }
        if (input.method === 'getMessageId') {
          const last = messageView(repositories, conversationId).length - 1;
          const current = input.currentMessageId ?? (Number.isInteger(input.args[0]) ? input.args[0] as number : undefined);
          return current === undefined ? last : Math.min(current, last);
        }
        if (input.method === 'getVariables') return stateView(resolveScope(input.args[0], input.args[1]));
        if (input.method === 'getAllVariables') {
          const rows = messageView(repositories, conversationId);
          const lastVariant = [...rows].reverse().find((row) => row.active_variant_id !== null)?.active_variant_id;
          return {
            global: stateView(resolveScope('global', null)),
            character: stateView(resolveScope('character', null)),
            preset: context.primaryPreset === null ? null : stateView(resolveScope('preset', null)),
            conversation: stateView(resolveScope('conversation', null)),
            messageVariant: lastVariant === undefined ? null : stateView(resolveScope('message-variant', lastVariant)),
            script: stateView(resolveScope('script', null)),
          };
        }
        if (input.method === 'replaceVariables') return replaceState(input.args);
        if (input.method === 'updateVariablesWith') return mutateState(input.args, 'merge');
        if (input.method === 'insertVariables') return mutateState(input.args, 'insert');
        if (input.method === 'deleteVariable') return mutateState(input.args, 'delete');
        if (input.method === 'getTavernRegexes') {
          const owner = targetOwner(input.args[0]);
          return repositories.extensionAssets.listByOwner(owner.kind, owner.entity.id)
            .filter((asset) => asset.kind === 'regex')
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((asset) => structuredClone(asset.payload));
        }
        if (input.method === 'replaceTavernRegexes') {
          if (!Array.isArray(input.args[0])) throw new RpcError('invalid_request', 400);
          const rules = input.args[0].map((rule) => TavernRegexSchema.parse(rule));
          const owner = targetOwner(input.args[1]);
          const expected = Number.isInteger(input.args[2]) ? input.args[2] as number : owner.entity.revision;
          if (expected !== owner.entity.revision) throw new RpcError('conflict', 409);
          return database.transaction(() => {
            const currentAssets = repositories.extensionAssets.listByOwner(owner.kind, owner.entity.id);
            const nextAssets = [
              ...rules.map((rule, ordinal) => ({
                kind: 'regex' as const, sourceKey: rule.id, ordinal, enabled: !rule.disabled,
                payload: structuredClone(rule), diagnostics: [] as string[],
              })),
              ...currentAssets.filter((asset) => asset.kind === 'tavern_helper').map((asset) => ({
                kind: asset.kind, sourceKey: asset.sourceKey, ordinal: asset.ordinal, enabled: asset.enabled,
                payload: structuredClone(asset.payload), diagnostics: [...asset.diagnostics],
              })),
            ];
            const extensions = overlayAttachedExtensionAssets(owner.entity.extensions, nextAssets, { replaceKinds: true });
            const updated = owner.kind === 'character'
              ? repositories.characters.update(owner.entity.id, expected, { extensions })
              : repositories.presets.update(owner.entity.id, expected, { extensions });
            if (!updated.ok) throw new RpcError('conflict', 409);
            repositories.extensionAssets.deleteByOwner(owner.kind, owner.entity.id);
            for (const asset of nextAssets) repositories.extensionAssets.create({
              id: randomUUID(), ownerKind: owner.kind, ownerId: owner.entity.id, ...asset,
            });
            return { ownerRevision: updated.value.revision, rules };
          });
        }
        if (input.method === 'getWorldbookNames') return repositories.worldbooks.list().map((book) => book.name);
        if (input.method === 'getWorldbook' || input.method === 'getLorebookEntries') {
          const key = input.args[0];
          const book = repositories.worldbooks.list().find((candidate) => candidate.id === key || candidate.name === key);
          if (book === undefined) throw new RpcError('not_found', 404);
          const entries = repositories.worldbookEntries.listByWorldbookId(book.id).map((entry) => structuredClone(entry));
          return input.method === 'getLorebookEntries' ? entries : { ...structuredClone(book), entries };
        }
        if (input.method === 'updateLorebookEntriesWith') {
          const bookKey = input.args[0];
          const updates = Array.isArray(input.args[1]) ? input.args[1] : undefined;
          const book = repositories.worldbooks.list().find((candidate) => candidate.id === bookKey || candidate.name === bookKey);
          if (book === undefined) throw new RpcError('not_found', 404);
          if (updates === undefined) throw new RpcError('invalid_request', 400);
          database.transaction(() => {
            for (const candidate of updates) {
              const update = record(candidate);
              const entry = typeof update?.id === 'string' ? repositories.worldbookEntries.get(update.id) : undefined;
              const patch = record(update?.patch);
              if (entry === undefined || entry.worldbookId !== book.id || patch === undefined) throw new RpcError('invalid_request', 400);
              const requestedRevision = update?.revision;
              const revision = Number.isInteger(requestedRevision) ? requestedRevision as number : entry.revision;
              const result = repositories.worldbookEntries.update(entry.id, revision, patch);
              if (!result.ok) throw new RpcError('conflict', 409);
            }
          });
          return repositories.worldbookEntries.listByWorldbookId(book.id);
        }
        if (input.method === 'substitudeMacros') {
          if (typeof input.args[0] !== 'string') throw new RpcError('invalid_request', 400);
          return substituteMacros(input.args[0]);
        }
        if (input.method === 'injectPrompts' || input.method === 'uninjectPrompts') {
          const state = stateView(resolveScope('script', null));
          const current = record(state.value.promptInjections) ?? {};
          const key = input.args[0];
          if (typeof key !== 'string' || key === '') throw new RpcError('invalid_request', 400);
          const injection = record(input.args[1]);
          if (input.method === 'injectPrompts' && (injection === undefined || typeof injection.content !== 'string'
            || (injection.position !== undefined && injection.position !== 'before' && injection.position !== 'after')
            || (injection.role !== undefined && !['system', 'user', 'assistant'].includes(String(injection.role))))) {
            throw new RpcError('invalid_request', 400);
          }
          if (input.method === 'injectPrompts') current[key] = structuredClone(injection);
          else delete current[key];
          return database.transaction(() => {
            const scriptState = replaceState([{ ...state.value, promptInjections: current }, 'script', null, state.revision]);
            const conversationState = stateView(resolveScope('conversation', null));
            const injections = record(conversationState.value.runtimePromptInjections) ?? {};
            const injectionKey = `${input.ownerKind}:${input.ownerId}:${input.scriptId}:${key}`;
            if (input.method === 'injectPrompts') injections[injectionKey] = {
              ownerKind: input.ownerKind, ownerId: input.ownerId, scriptId: input.scriptId,
              bundleDigest: input.bundleDigest,
              value: structuredClone(injection),
            };
            else delete injections[injectionKey];
            replaceState([{
              ...conversationState.value, runtimePromptInjections: injections,
            }, 'conversation', null, conversationState.revision]);
            return scriptState;
          });
        }
        throw new RpcError('not_supported', 422);
      })();
      return value;
    },
  };
}
