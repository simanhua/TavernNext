export interface InteractiveMessageContext {
  conversationId: string;
  messageId: number;
  variantId: string;
  hasReasoning: boolean;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function buildInteractiveFrameDocument(source: string, context: InteractiveMessageContext, nonce: string): string {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(source)?.[1] ?? '';
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source)?.[1] ?? source;
  const serialized = JSON.stringify(context).replaceAll('<', '\\u003c');
  const bootstrap = `<script>
    (() => {
      const context = ${serialized};
      const expectedNonce = ${JSON.stringify(nonce)};
      let port;
      let sequence = 0;
      const pending = new Map();
      const call = (method, args = []) => new Promise((resolve, reject) => {
        if (!port) return reject(Object.assign(new Error('runtime_not_ready'), { code: 'runtime_not_ready' }));
        const requestId = 'frontend-' + (++sequence);
        const timeout = setTimeout(() => { pending.delete(requestId); reject(Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })); }, 10000);
        pending.set(requestId, { resolve, reject, timeout });
        port.postMessage({ requestId, method, args });
      });
      addEventListener('message', event => {
        if (event.source !== parent || event.origin !== location.origin || event.data?.channel !== 'tavernnext-frontend-init' || event.data?.nonce !== expectedNonce || !event.ports[0]) return;
        port = event.ports[0];
        port.onmessage = result => {
          const request = pending.get(result.data?.requestId);
          if (!request) return;
          pending.delete(result.data.requestId); clearTimeout(request.timeout);
          result.data.ok ? request.resolve(result.data.value) : request.reject(Object.assign(new Error(result.data.error), { code: result.data.error }));
        };
        port.start();
      }, { once: true });
      window.TavernNextContext = Object.freeze(context);
      window.getMessageId = () => context.messageId;
      window.getVariables = () => call('getVariables');
      window.TavernHelper = new Proxy({}, { get: (_, method) => (...args) => call(String(method), args) });
      window.tavernHelper = window.TavernHelper;
    })();
  </script>`;
  return `<!doctype html><html><head>${bootstrap}${head}</head><body><div id="chat"><div class="mes" mesid="${context.messageId}" data-variant-id="${escapeHtml(context.variantId)}"><div class="mes_reasoning" hidden data-present="${context.hasReasoning}"></div><div class="mes_text">${body}</div></div></div></body></html>`;
}
