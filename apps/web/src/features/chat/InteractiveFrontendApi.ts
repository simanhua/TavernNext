import type { InteractiveMessageContext } from './interactive-frame-document.js';
import { roleplayDocumentPlainText, type RoleplayDocument } from '@tavernnext/domain';

/** Variant-bound capability policy for accepted interactive message frontends. */
export async function callInteractiveFrontendApi(
  context: InteractiveMessageContext,
  method: string,
  args: unknown[] = [],
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (method === 'getMessageId') return context.messageId;
  if (method === 'getVariables') {
    const options = typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])
      ? args[0] as Record<string, unknown>
      : undefined;
    let scope = 'message-variant';
    let scopeId = context.variantId;
    if (options?.type === 'character') {
      const detailResponse = await fetcher(`/api/conversations/${encodeURIComponent(context.conversationId)}/messages`);
      if (!detailResponse.ok) throw new Error((await detailResponse.json() as { error?: string }).error ?? `http_${detailResponse.status}`);
      const detail = await detailResponse.json() as { conversation?: { characterId?: unknown } };
      if (typeof detail.conversation?.characterId !== 'string') throw new Error('scope_owner_not_found');
      scope = 'character';
      scopeId = detail.conversation.characterId;
    } else if (options?.type !== undefined && options.type !== 'message') {
      throw Object.assign(new Error('not_supported'), { code: 'not_supported' });
    }
    const response = await fetcher(`/api/runtime-states/${scope}/${encodeURIComponent(scopeId)}`);
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `http_${response.status}`);
    const payload = await response.json() as { value?: unknown };
    return payload.value ?? {};
  }
  if (method === 'getChatMessages' || method === 'getLastMessageId') {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(context.conversationId)}/messages`);
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `http_${response.status}`);
    const payload = await response.json() as { messages: Array<{
      content: string; role: string;
      variants?: Array<{ id: string; content: string; document?: RoleplayDocument }>;
      activeVariantId?: string;
    }> };
    if (method === 'getLastMessageId') return payload.messages.length - 1;
    return payload.messages.map((message, messageId) => {
      const active = message.variants?.find((variant) => variant.id === message.activeVariantId);
      return {
      message_id: messageId, role: message.role,
      message: active?.document === undefined
        ? active?.content ?? message.content
        : roleplayDocumentPlainText(active.document),
      active_variant_id: message.activeVariantId ?? null,
      };
    });
  }
  if (method === 'loadApprovedHtml') {
    const url = args[0];
    if (typeof url !== 'string') throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    const query = new URLSearchParams({ sourceVariantId: context.variantId, url });
    const response = await fetcher(
      `/api/conversations/${encodeURIComponent(context.conversationId)}/interactive-resource?${query.toString()}`,
    );
    if (!response.ok) {
      const payload = await response.json() as { error?: string };
      throw Object.assign(new Error(payload.error ?? `http_${response.status}`), {
        code: payload.error ?? `http_${response.status}`,
      });
    }
    return response.text();
  }
  if (method === 'createChatMessages' || method === 'triggerSlash') {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(context.conversationId)}/interactive-actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVariantId: context.variantId, method, args }),
    });
    const payload = await response.json() as { value?: unknown; error?: string };
    if (!response.ok) throw Object.assign(new Error(payload.error ?? `http_${response.status}`), {
      code: payload.error ?? `http_${response.status}`,
    });
    return payload.value;
  }
  throw Object.assign(new Error('not_supported'), { code: 'not_supported' });
}
