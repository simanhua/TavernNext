import { randomUUID } from 'node:crypto';
import { applyMvuMessage, createMvuState } from '@tavernnext/st-compat';
import type { Repositories } from '../db/repositories.js';
import { assertRuntimeStateValue } from '../runtime-state-validation.js';
import { EXTENSION_TRUST_RISK_VERSION, extensionExecutableDigest } from './extension-trust-service.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scriptContent(value: unknown): string {
  const item = record(value);
  return typeof item?.content === 'string' ? item.content : '';
}

export function createMvuRuntimeService(repositories: Repositories) {
  const initEntries = (conversationId: string) => {
    const conversation = repositories.conversations.get(conversationId);
    const character = conversation === undefined ? undefined : repositories.characters.get(conversation.characterId);
    if (character?.worldbookId === undefined) return [];
    const grant = repositories.extensionTrustGrants.getByOwner('character', character.id);
    if (grant?.riskVersion !== EXTENSION_TRUST_RISK_VERSION
      || grant.bundleDigest !== extensionExecutableDigest(repositories, 'character', character.id)) return [];
    const enabled = repositories.extensionAssets.listByOwner('character', character.id).some((asset) => (
      asset.kind === 'tavern_helper' && asset.enabled
      && /MagVarUpdate|\bMVU\b/i.test(`${scriptContent(asset.payload)} ${record(asset.payload)?.name ?? ''}`)
    ));
    if (!enabled) return [];
    return repositories.worldbookEntries.listByWorldbookId(character.worldbookId)
      .filter((entry) => /\[InitVar\]/i.test(entry.comment))
      .map((entry) => ({ id: `${character.worldbookId}:${String(entry.sourceUid ?? entry.id)}`, content: entry.content }));
  };

  return {
    initializeGreetingVariants(conversationId: string): void {
      const entries = initEntries(conversationId);
      if (entries.length === 0) return;
      for (const message of repositories.messages.listByConversationId(conversationId)) {
        if (message.role !== 'assistant') continue;
        for (const variant of repositories.messageVariants.listByMessageId(message.id)) {
          if (repositories.extensionStates.getByScope('message-variant', variant.id) !== undefined) continue;
          const value = createMvuState(entries, variant.content);
          assertRuntimeStateValue(value);
          repositories.extensionStates.create({
            id: randomUUID(), scope: 'message-variant', scopeId: variant.id, value,
          });
        }
      }
    },
    commitCompletedVariant(conversationId: string, variantId: string, content: string): void {
      const entries = initEntries(conversationId);
      if (entries.length === 0) return;
      const variant = repositories.messageVariants.get(variantId);
      if (variant === undefined) return;
      const messages = repositories.messages.listByConversationId(conversationId);
      const messageIndex = messages.findIndex((message) => message.id === variant.messageId);
      if (messageIndex < 0) return;
      const current = repositories.extensionStates.getByScope('message-variant', variant.id);
      const prior = current ?? [...messages.slice(0, messageIndex)].reverse().flatMap((message) => (
        message.role === 'assistant' && message.activeVariantId !== null
          ? [repositories.extensionStates.getByScope('message-variant', message.activeVariantId)]
          : []
      )).find((state) => state !== undefined);
      let value: Record<string, unknown>;
      try {
        const base = prior === undefined ? createMvuState(entries) : structuredClone(prior.value);
        value = applyMvuMessage(base, content);
        assertRuntimeStateValue(value);
      } catch {
        // MVU compatibility failures never discard a completed model reply.
        return;
      }
      if (current === undefined) {
        repositories.extensionStates.create({
          id: randomUUID(), scope: 'message-variant', scopeId: variant.id, value,
        });
      } else {
        const updated = repositories.extensionStates.update(current.id, current.revision, { value });
        if (!updated.ok) throw new Error(`mvu_state_${updated.reason}`);
      }
    },
  };
}
