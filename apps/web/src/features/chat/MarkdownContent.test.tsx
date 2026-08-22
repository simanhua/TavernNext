// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from './MarkdownContent.js';
import { callReadOnlyFrontendApi } from './InteractiveFrontendApi.js';

afterEach(cleanup);

describe('MarkdownContent', () => {
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
    expect(iframe?.getAttribute('loading')).toBe('lazy');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(iframe?.srcdoc).toContain('id="chat"');
    expect(iframe?.srcdoc).toContain('mesid="4"');
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

  it('limits opaque iframe RPC to variant-bound read APIs with stable errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      scope: 'message-variant', scopeId: 'variant-1', revision: 2, value: { hp: 9 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const context = { conversationId: 'conversation-1', messageId: 4, variantId: 'variant-1', hasReasoning: false };

    await expect(callReadOnlyFrontendApi(context, 'getVariables', fetcher)).resolves.toMatchObject({ value: { hp: 9 } });
    expect(fetcher).toHaveBeenCalledWith('/api/runtime-states/message-variant/variant-1');
    await expect(callReadOnlyFrontendApi(context, 'replaceVariables', fetcher)).rejects.toMatchObject({ code: 'not_supported' });
  });
});
