import { useEffect, useMemo, useRef } from 'react';
import * as Vue from 'vue';
import { callInteractiveFrontendApi } from './InteractiveFrontendApi.js';
import {
  buildInteractiveFrameDocument,
  type InteractiveMessageContext,
} from './interactive-frame-document.js';

export type { InteractiveMessageContext } from './interactive-frame-document.js';

type InteractiveCompatibilityWindow = Window & typeof globalThis & Record<string, unknown>;

export function installInteractiveCompatibilityGlobals(runtimeWindow: InteractiveCompatibilityWindow): void {
  runtimeWindow.Vue = Vue;
  runtimeWindow.getTavernHelperVersion = () => 'compat-0';
  runtimeWindow.getTavernVersion = () => '1.18.0-compat';
  runtimeWindow.waitGlobalInitialized = async () => undefined;
}

export function InteractiveMessageFrame({ html, context }: { html: string; context: InteractiveMessageContext }) {
  installInteractiveCompatibilityGlobals(window as InteractiveCompatibilityWindow);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), [context.conversationId, context.messageId, context.variantId]);
  const source = useMemo(
    () => buildInteractiveFrameDocument(html, context, nonce, window.location.origin),
    [context.hasReasoning, html, nonce],
  );
  const portRef = useRef<MessagePort | undefined>(undefined);
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe === null) return undefined;
    const connect = (event: MessageEvent) => {
      const runtimeWindow = iframe.contentWindow;
      if (runtimeWindow === null || event.source !== runtimeWindow || !['null', window.location.origin].includes(event.origin)
        || event.data?.channel !== 'tavernnext-frontend-ready' || event.data?.nonce !== nonce) return;
      portRef.current?.close();
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      channel.port1.onmessage = (event) => {
        const requestId = event.data?.requestId;
        const method = event.data?.method;
        if (typeof requestId !== 'string' || typeof method !== 'string') return;
        void callInteractiveFrontendApi(context, method, Array.isArray(event.data?.args) ? event.data.args : []).then(
          (value) => {
            channel.port1.postMessage({ requestId, ok: true, value });
            if (method === 'createChatMessages' || method === 'triggerSlash') {
              window.dispatchEvent(new CustomEvent('tavernnext:runtime-mutated', { detail: { method } }));
            }
          },
          (cause: unknown) => channel.port1.postMessage({
            requestId, ok: false,
            error: cause instanceof Error && 'code' in cause ? String(cause.code) : cause instanceof Error ? cause.message : 'runtime_error',
          }),
        );
      };
      channel.port1.start();
      runtimeWindow.postMessage(
        { channel: 'tavernnext-frontend-init', nonce }, '*', [channel.port2],
      );
    };
    window.addEventListener('message', connect);
    return () => {
      window.removeEventListener('message', connect);
      portRef.current?.close();
      portRef.current = undefined;
    };
  }, [source]);
  return (
    <iframe
      ref={iframeRef}
      className="interactive-message-frame"
      title={`Interactive message ${context.messageId}`}
      loading="eager"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={source}
    />
  );
}
