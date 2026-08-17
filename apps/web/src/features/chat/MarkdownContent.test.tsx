// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent.js';

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
});
