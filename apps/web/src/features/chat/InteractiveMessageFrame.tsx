import { useEffect, useMemo, useRef } from 'react';
import { callReadOnlyFrontendApi } from './InteractiveFrontendApi.js';
import {
  buildInteractiveFrameDocument,
  type InteractiveMessageContext,
} from './interactive-frame-document.js';

export type { InteractiveMessageContext } from './interactive-frame-document.js';

export function InteractiveMessageFrame({ html, context }: { html: string; context: InteractiveMessageContext }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), [context.conversationId, context.messageId, context.variantId]);
  const source = useMemo(
    () => buildInteractiveFrameDocument(html, context, nonce),
    [context.hasReasoning, html, nonce],
  );
  const portRef = useRef<MessagePort | undefined>(undefined);
  useEffect(() => () => portRef.current?.close(), []);
  return (
    <iframe
      ref={iframeRef}
      className="interactive-message-frame"
      title={`Interactive message ${context.messageId}`}
      loading="lazy"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={source}
      onLoad={() => {
        portRef.current?.close();
        const channel = new MessageChannel();
        portRef.current = channel.port1;
        channel.port1.onmessage = (event) => {
          const requestId = event.data?.requestId;
          const method = event.data?.method;
          if (typeof requestId !== 'string' || typeof method !== 'string') return;
          void callReadOnlyFrontendApi(context, method).then(
            (value) => channel.port1.postMessage({ requestId, ok: true, value }),
            (cause: unknown) => channel.port1.postMessage({
              requestId, ok: false,
              error: cause instanceof Error && 'code' in cause ? String(cause.code) : cause instanceof Error ? cause.message : 'runtime_error',
            }),
          );
        };
        channel.port1.start();
        iframeRef.current?.contentWindow?.postMessage(
          { channel: 'tavernnext-frontend-init', nonce }, window.location.origin, [channel.port2],
        );
      }}
    />
  );
}
