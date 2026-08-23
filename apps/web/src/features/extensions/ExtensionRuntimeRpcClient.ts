import {
  MUTATING_TAVERN_HELPER_METHODS,
  type ExtensionRuntimeRpcRequest,
} from '@tavernnext/extension-runtime';

export type RuntimeApiCall = ExtensionRuntimeRpcRequest & { conversationId: string };
export type RuntimeApiCaller = (input: RuntimeApiCall) => Promise<unknown>;

export function createExtensionRuntimeRpcClient(
  fetcher: typeof fetch,
  onMutation: (input: RuntimeApiCall) => void,
): RuntimeApiCaller {
  return async (input) => {
    const { conversationId, ...body } = input;
    const response = await fetcher(`/api/conversations/${encodeURIComponent(conversationId)}/extension-runtime/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json() as { value?: unknown; error?: string };
    if (!response.ok) {
      const code = payload.error ?? `http_${response.status}`;
      throw Object.assign(new Error(code), { code });
    }
    if (MUTATING_TAVERN_HELPER_METHODS.has(input.method)) onMutation(input);
    return payload.value;
  };
}
