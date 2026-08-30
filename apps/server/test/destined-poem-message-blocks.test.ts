// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// Scene browser assets intentionally stay framework-free and ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { bindDestinedPoemMessageBlocks, parseDestinedPoemOptions, renderDestinedPoemMessage } from '../assets/official-scenes/destined-poem/frontend/message-blocks.mjs';

describe('Destined Poem native message blocks', () => {
  it('renders the five supported block families without exposing their raw tags', () => {
    const html = renderDestinedPoemMessage(`<tp>伪造地点 | <script>tp()</script></tp>
<gametxt>
**正文**
<action_info>
{战况总览}
| 回合: 1 | 环境: 林地 |
</action_info>
</gametxt>
<summary>这是一段**摘要**。</summary>
<options>
1. 向森林深处前进
2、留在原地
</options>`, { idPrefix: 'turn-a' });

    expect(html).not.toContain('伪造地点');
    for (const tag of ['tp', 'gametxt', 'action_info', 'options']) {
      expect(html.toLowerCase()).not.toContain(`&lt;${tag}`);
      expect(html.toLowerCase()).not.toContain(`<${tag}`);
    }
    expect(html).not.toContain('&lt;summary&gt;');
    expect(html).toContain('<strong>正文</strong>');
    expect(html).toContain('class="action-panel-title">战况总览');
    expect(html).toContain('class="poem-message-summary"');
    expect(html).toContain('<strong>摘要</strong>');
    expect(html).toContain('data-poem-option-text="向森林深处前进"');
    expect(html).toContain('data-poem-option-text="留在原地"');
  });

  it('accepts case-insensitive aliases and joins option continuation lines', () => {
    expect(parseDestinedPoemOptions('1) 第一行\n继续说明\n2：第二项')).toEqual([
      '第一行 继续说明',
      '第二项',
    ]);
    const html = renderDestinedPoemMessage('<ACTION_OPTIONS>1. A\n2. B</ACTION_OPTIONS>');
    expect(html.match(/class="poem-option"/g)).toHaveLength(2);
    expect(html).not.toContain('ACTION_OPTIONS');
  });

  it('keeps malformed and unsupported blocks inert and escaped', () => {
    const html = renderDestinedPoemMessage(`before <options>1. unfinished
<char_info><img src=x onerror=alert(1)></char_info>
<script>window.unsafe = true</script>`);
    expect(html).toContain('before');
    expect(html).toContain('&lt;options&gt;');
    expect(html).toContain('&lt;char_info&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;window.unsafe = true&lt;/script&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('class="poem-message-options"');
  });

  it('streams gametxt prose while suppressing unfinished control blocks', () => {
    const gameText = renderDestinedPoemMessage('<gametxt>可见的**正文**', { streaming: true });
    expect(gameText).toContain('可见的<strong>正文</strong>');
    expect(gameText).not.toContain('gametxt');

    const tp = renderDestinedPoemMessage('开头<tp>不应泄漏', { streaming: true });
    expect(tp).toContain('开头');
    expect(tp).not.toContain('不应泄漏');

    const options = renderDestinedPoemMessage('正文<options>1. 暂未完成', { streaming: true });
    expect(options).toContain('正文');
    expect(options).not.toContain('暂未完成');

    const completeOptions = renderDestinedPoemMessage('<options>1. 已完成</options>', { streaming: true });
    expect(completeOptions).toContain('data-poem-option-text="已完成" disabled');
  });

  it('binds safe option text to the caller without executing embedded markup', () => {
    const host = document.createElement('div');
    host.innerHTML = renderDestinedPoemMessage('<options>1. <script>never()</script> "继续"</options>');
    const onOption = vi.fn();
    bindDestinedPoemMessageBlocks(host, onOption);

    const button = host.querySelector<HTMLButtonElement>('[data-poem-option-text]')!;
    button.click();

    expect(onOption).toHaveBeenCalledWith('<script>never()</script> "继续"');
    expect(host.querySelector('script')).toBeNull();
  });
});
