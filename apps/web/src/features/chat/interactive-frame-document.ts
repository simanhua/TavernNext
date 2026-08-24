export interface InteractiveMessageContext {
  conversationId: string;
  messageId: number;
  variantId: string;
  hasReasoning: boolean;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function buildInteractiveFrameDocument(
  source: string,
  context: InteractiveMessageContext,
  nonce: string,
  parentOrigin: string,
): string {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(source)?.[1] ?? '';
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source)?.[1] ?? source;
  const serialized = JSON.stringify(context).replaceAll('<', '\\u003c');
  const bootstrap = `<script>
    (() => {
      const context = ${serialized};
      const expectedNonce = ${JSON.stringify(nonce)};
      const expectedParentOrigin = ${JSON.stringify(parentOrigin)};
      let port;
      let sequence = 0;
      const pending = new Map();
      let markReady;
      const ready = new Promise(resolve => { markReady = resolve; });
      const parentVue = parent.Vue;
      const bindVueAppFactory = factory => (...args) => {
        const app = factory(...args);
        const mount = app.mount.bind(app);
        app.mount = target => mount(typeof target === 'string' ? document.querySelector(target) : target);
        return app;
      };
      window.Vue = new Proxy(parentVue, { get: (target, property, receiver) => {
        if (property === 'createApp' || property === 'createSSRApp') return bindVueAppFactory(Reflect.get(target, property, receiver));
        return Reflect.get(target, property, receiver);
      } });
      window.getTavernHelperVersion = parent.getTavernHelperVersion;
      window.getTavernVersion = parent.getTavernVersion;
      window.waitGlobalInitialized = parent.waitGlobalInitialized;
      if (parent.SillyTavern) window.SillyTavern = parent.SillyTavern;
      const call = async (method, args = []) => {
        if (!port) await ready;
        return new Promise((resolve, reject) => {
        const requestId = 'frontend-' + (++sequence);
        const timeout = setTimeout(() => { pending.delete(requestId); reject(Object.assign(new Error('runtime_timeout'), { code: 'runtime_timeout' })); }, 10000);
        pending.set(requestId, { resolve, reject, timeout });
        port.postMessage({ requestId, method, args });
        });
      };
      const announceReady = () => parent.postMessage(
        { channel: 'tavernnext-frontend-ready', nonce: expectedNonce }, '*',
      );
      const announceTimer = setInterval(announceReady, 100);
      const receiveInit = event => {
        if (event.source !== parent || event.origin !== expectedParentOrigin || event.data?.channel !== 'tavernnext-frontend-init' || event.data?.nonce !== expectedNonce || !event.ports[0]) return;
        removeEventListener('message', receiveInit);
        clearInterval(announceTimer);
        port = event.ports[0];
        markReady();
        port.onmessage = result => {
          const request = pending.get(result.data?.requestId);
          if (!request) return;
          pending.delete(result.data.requestId); clearTimeout(request.timeout);
          result.data.ok ? request.resolve(result.data.value) : request.reject(Object.assign(new Error(result.data.error), { code: result.data.error }));
        };
        port.start();
      };
      addEventListener('message', receiveInit);
      announceReady();
      window.TavernNextContext = Object.freeze(context);
      window.getMessageId = () => context.messageId;
      window.getCurrentMessageId = () => context.messageId;
      window.getVariables = (...args) => call('getVariables', args);
      window.getChatMessages = (...args) => call('getChatMessages', args);
      window.getLastMessageId = (...args) => call('getLastMessageId', args);
      window.createChatMessages = (...args) => call('createChatMessages', args);
      window.triggerSlash = (...args) => call('triggerSlash', args);
      window.TavernHelper = new Proxy({}, { get: (_, method) => (...args) => call(String(method), args) });
      window.tavernHelper = window.TavernHelper;
      const loadApprovedHtml = async (selector, url) => {
        if (typeof selector !== 'string' || typeof url !== 'string') throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
        const html = await call('loadApprovedHtml', [url]);
        const parsed = new DOMParser().parseFromString(String(html), 'text/html');
        const scripts = [...parsed.querySelectorAll('script')];
        scripts.forEach(script => script.remove());
        let base = document.head.querySelector('base[data-tavernnext-approved-loader]');
        if (!base) {
          base = document.createElement('base');
          base.setAttribute('data-tavernnext-approved-loader', '');
          document.head.append(base);
        }
        base.href = url;
        for (const child of [...parsed.head.children]) {
          if (!['BASE', 'SCRIPT', 'TITLE'].includes(child.tagName)) document.head.append(document.importNode(child, true));
        }
        const targets = selector === 'body' ? [document.body] : [...document.querySelectorAll(selector)];
        for (const target of targets) target.replaceChildren(...[...parsed.body.childNodes].map(node => document.importNode(node, true)));
        for (const source of scripts) {
          const script = document.createElement('script');
          for (const attribute of source.attributes) script.setAttribute(attribute.name, attribute.value);
          if (source.src) script.src = new URL(source.getAttribute('src') ?? '', url).toString();
          script.textContent = source.textContent;
          document.body.append(script);
        }
      };
      window.$ = selector => ({ load: url => loadApprovedHtml(selector, url) });
    })();
  </script>`;
  return `<!doctype html><html><head>${bootstrap}${head}</head><body><div id="chat"><div class="mes" mesid="${context.messageId}" data-variant-id="${escapeHtml(context.variantId)}"><div class="mes_reasoning" hidden data-present="${context.hasReasoning}"></div><div class="mes_text">${body}</div></div></div></body></html>`;
}
