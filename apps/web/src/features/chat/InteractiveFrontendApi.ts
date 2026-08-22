import type { InteractiveMessageContext } from './interactive-frame-document.js';

/** Read-only capability policy for model-visible interactive message frontends. */
export async function callReadOnlyFrontendApi(
  context: InteractiveMessageContext,
  method: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (method === 'getMessageId') return context.messageId;
  if (method === 'getVariables') {
    const response = await fetcher(`/api/runtime-states/message-variant/${encodeURIComponent(context.variantId)}`);
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `http_${response.status}`);
    return response.json();
  }
  if (method === 'getChatMessages' || method === 'getLastMessageId') {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(context.conversationId)}/messages`);
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `http_${response.status}`);
    const payload = await response.json() as { messages: Array<{
      content: string; role: string; variants?: Array<{ id: string; content: string }>; activeVariantId?: string;
    }> };
    if (method === 'getLastMessageId') return payload.messages.length - 1;
    return payload.messages.map((message, messageId) => ({
      message_id: messageId, role: message.role,
      message: message.variants?.find((variant) => variant.id === message.activeVariantId)?.content ?? message.content,
      active_variant_id: message.activeVariantId ?? null,
    }));
  }
  throw Object.assign(new Error('not_supported'), { code: 'not_supported' });
}
