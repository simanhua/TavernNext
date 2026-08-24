// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interactiveHtmlFences, MarkdownContent } from './MarkdownContent.js';
import { callInteractiveFrontendApi } from './InteractiveFrontendApi.js';
import { installInteractiveCompatibilityGlobals } from './InteractiveMessageFrame.js';

afterEach(cleanup);

describe('MarkdownContent', () => {
  it('installs the globals required before a trusted remote message frontend starts', async () => {
    const runtimeWindow = {} as Window & typeof globalThis & Record<string, unknown>;
    installInteractiveCompatibilityGlobals(runtimeWindow);

    expect((runtimeWindow.Vue as typeof import('vue')).ref('ready').value).toBe('ready');
    expect((runtimeWindow.getTavernHelperVersion as () => string)()).toBe('compat-0');
    await expect((runtimeWindow.waitGlobalInitialized as () => Promise<void>)()).resolves.toBeUndefined();
  });

  it('renders common and GitHub-flavored Markdown as semantic HTML', () => {
    const { container } = render(
      <MarkdownContent content={'## Plan\n\n- **First** item\n- [x] Finished\n\n| Name | State |\n| --- | --- |\n| TavernNext | Ready |\n\n[`Open docs`](https://example.com)\n\n```ts\nconst ready = true;\n```'} />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Plan' })).not.toBeNull();
    expect(screen.getByText('First').tagName).toBe('STRONG');
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('table')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Open docs' }).getAttribute('target')).toBe('_blank');
    expect(container.querySelector('pre code')?.textContent).toContain('const ready = true;');
  });

  it('does not turn raw HTML or unsafe links into executable markup', () => {
    const { container } = render(
      <MarkdownContent content={'<script>window.hacked = true</script>\n\n[unsafe](javascript:alert(1))'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('unsafe');
  });

  it('keeps fenced HTML inert while streaming and restores a lazy same-origin iframe after completion', () => {
    const html = '```html\n<html><head><title>Panel</title></head><body><button>Act</button></body></html>\n```';
    const { container, rerender, unmount } = render(<MarkdownContent content={html} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('<html>');

    rerender(<MarkdownContent content={html} interactive={{
      conversationId: 'conversation-1', messageId: 4, variantId: 'variant-1', hasReasoning: true,
    }} />);
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('loading')).toBe('eager');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe?.srcdoc).toContain('id="chat"');
    expect(iframe?.srcdoc).toContain('mesid="4"');
    expect(iframe?.srcdoc).toContain('window.getCurrentMessageId');
    expect(iframe?.srcdoc).toContain('tavernnext-frontend-ready');
    expect(iframe?.srcdoc).toContain("document.querySelector(target)");
    expect(iframe?.srcdoc).toContain('data-variant-id="variant-1"');
    expect(iframe?.srcdoc).toContain('class="mes_reasoning"');
    expect(iframe?.srcdoc).toContain('<button>Act</button>');
    expect(iframe!.srcdoc.indexOf('TavernNextContext')).toBeLessThan(iframe!.srcdoc.indexOf('<title>Panel</title>'));

    rerender(<MarkdownContent content={html} interactive={{
      conversationId: 'conversation-2', messageId: 7, variantId: 'variant-2', hasReasoning: false,
    }} />);
    expect(container.querySelector('iframe')?.srcdoc).toContain('data-variant-id="variant-2"');
    expect(container.querySelector('iframe')?.srcdoc).toContain('mesid="7"');
    unmount();
    const restored = render(<MarkdownContent content={html} interactive={{
      conversationId: 'conversation-2', messageId: 7, variantId: 'variant-2', hasReasoning: false,
    }} />);
    expect(restored.container.querySelector('iframe')?.srcdoc).toContain('data-variant-id="variant-2"');
  });

  it('does not iframe ordinary code or HTML-like non-fence content', () => {
    const { container } = render(<MarkdownContent
      content={'`<body>inline</body>`\n\n<div>raw</div>\n\n```html\n<span>fragment</span>\n```'}
      interactive={{ conversationId: 'conversation-1', messageId: 0, variantId: 'variant-1', hasReasoning: false }}
    />);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('accepts the real card no-language status fence only when display projection supplied it', () => {
    const source = '<body><script>document.body.dataset.ready = "true"</script></body>';
    const content = `\`\`\`\n${source}\n\`\`\``;
    const interactive = {
      conversationId: 'conversation-1', messageId: 2, variantId: 'variant-1', hasReasoning: false,
    };
    const { container, rerender } = render(<MarkdownContent content={content} interactive={interactive} />);
    expect(container.querySelector('iframe')?.srcdoc).toContain('dataset.ready');

    rerender(<MarkdownContent content={content} interactive={interactive} inertInteractiveHtml={[source]} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('<body>');
  });

  it('boots the real status loader through the approved HTML bridge', () => {
    const source = `<body><script>$('body').load('https://cdn.example/status.html')</script></body>`;
    const { container } = render(<MarkdownContent
      content={`<details><summary>Variables</summary>updated</details>\`\`\`\n${source}\n\`\`\``}
      interactive={{ conversationId: 'conversation-1', messageId: 2, variantId: 'variant-1', hasReasoning: false }}
    />);
    expect(container.querySelector('iframe')).not.toBeNull();
    const srcdoc = container.querySelector('iframe')?.srcdoc ?? '';

    expect(srcdoc).toContain('window.$');
    expect(srcdoc).toContain("call('loadApprovedHtml'");
    expect(srcdoc.indexOf('window.$')).toBeLessThan(srcdoc.indexOf("$('body').load"));
  });

  it('keeps adjacent raw model HTML inert after shared fence normalization', () => {
    const source = `<body><script>window.rawModelCode = true</script></body>`;
    const content = `raw model text\`\`\`\n${source}\n\`\`\``;
    const inert = interactiveHtmlFences(content);
    const { container } = render(<MarkdownContent
      content={content}
      interactive={{ conversationId: 'conversation-1', messageId: 2, variantId: 'variant-1', hasReasoning: false }}
      inertInteractiveHtml={inert}
    />);

    expect(inert).toEqual([source]);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('window.rawModelCode');
  });

  it('limits opaque iframe RPC to variant-bound read APIs with stable errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      scope: 'message-variant', scopeId: 'variant-1', revision: 2, value: { hp: 9 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const context = { conversationId: 'conversation-1', messageId: 4, variantId: 'variant-1', hasReasoning: false };

    await expect(callInteractiveFrontendApi(context, 'getVariables', [], fetcher)).resolves.toEqual({ hp: 9 });
    expect(fetcher).toHaveBeenCalledWith('/api/runtime-states/message-variant/variant-1');
    await expect(callInteractiveFrontendApi(context, 'replaceVariables', [], fetcher)).rejects.toMatchObject({ code: 'not_supported' });
  });

  it('loads message frontend HTML only through the variant-bound approved cache route', async () => {
    const fetcher = vi.fn(async () => new Response('<main>Approved status</main>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }));
    const context = { conversationId: 'conversation-1', messageId: 4, variantId: 'variant-1', hasReasoning: false };

    await expect(callInteractiveFrontendApi(
      context, 'loadApprovedHtml', ['https://cdn.example/status.html'], fetcher,
    )).resolves.toBe('<main>Approved status</main>');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/conversations/conversation-1/interactive-resource?sourceVariantId=variant-1&url=https%3A%2F%2Fcdn.example%2Fstatus.html',
    );
  });

  it('exposes only variant-bound message creation and trigger actions to accepted frontends', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const context = { conversationId: 'conversation-1', messageId: 4, variantId: 'variant-1', hasReasoning: false };

    await expect(callInteractiveFrontendApi(context, 'createChatMessages', [[{
      role: 'user', message: 'Custom start payload',
    }]], fetcher)).resolves.toBe('ok');
    await expect(callInteractiveFrontendApi(context, 'triggerSlash', ['/trigger'], fetcher)).resolves.toBe('ok');

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/conversations/conversation-1/interactive-actions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceVariantId: 'variant-1', method: 'createChatMessages',
        args: [[{ role: 'user', message: 'Custom start payload' }]],
      }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/conversations/conversation-1/interactive-actions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVariantId: 'variant-1', method: 'triggerSlash', args: ['/trigger'] }),
    });
  });

  it('resolves character-scoped variables requested by the real custom-start frontend', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/messages')) return new Response(JSON.stringify({
        conversation: { characterId: 'character-1' }, messages: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        scope: 'character', scopeId: 'character-1', revision: 1, value: { start_presets: { presets: [] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const context = { conversationId: 'conversation-1', messageId: 4, variantId: 'variant-1', hasReasoning: false };

    await expect(callInteractiveFrontendApi(context, 'getVariables', [{ type: 'character' }], fetcher))
      .resolves.toEqual({ start_presets: { presets: [] } });
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/conversations/conversation-1/messages');
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/runtime-states/character/character-1');
  });
});
