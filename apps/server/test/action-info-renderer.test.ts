import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally stay framework-free and ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { renderActionInfoMessage, renderCombatActionInfoMessage } from '../assets/official-scenes/destined-poem/frontend/action-info.mjs';

describe('Destined Poem action_info renderer', () => {
  it('renders narrative Markdown blocks and inline formatting without allowing raw HTML', () => {
    const html = renderCombatActionInfoMessage(`**【初始属性分配】**

---

你拥有**24点属性点**。

| 属性 | 当前 | 说明 |
|------|------|------|
| 力量 | 4 | 近战伤害 |
| 敏捷 | 5 | 行动速度 |

> ⚠️ **请注意**：每项上限6点。

1. **命途之书** — 记录命运
2. **万象百工** — 精通生产

[安全链接](https://example.com/a*b*) [危险链接](javascript:alert(1))

<script>alert('unsafe')</script>`);

    expect(html).toContain('<strong>【初始属性分配】</strong>');
    expect(html).toContain('<hr');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>属性</th>');
    expect(html).toContain('<td>力量</td>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<a href="https://example.com/a*b*"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves narrative and renders the original title/pipe-row structure as a panel', () => {
    const html = renderActionInfoMessage(`Before
<action_info>
{战况总览}
| 回合: 1 | 类型: 标准 | 环境: 云海 |
| 旅人: HP: 30/100 | MP: 20/40 | SP: 8/20 | 力量: 3 | 敏捷: 4 | 体质: 3 | 智力: 2 | 精神: 2 |
</action_info>
After`, 'message-a');

    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).toContain('class="action-panel"');
    expect(html).toContain('class="action-panel-title">战况总览');
    expect(html).toContain('class="action-resource hp low">HP 30/100');
    expect(html).toContain('class="action-resource mp">MP 20/40');
    expect(html).toContain('class="action-stat str">力量 3');
    expect(html).not.toContain('&lt;action_info&gt;');
  });

  it('renders multiple sections and panels with independent collapse targets', () => {
    const html = renderActionInfoMessage(`<action_info>
{行动顺序}
| 序列：旅人 -> 敌人 |
{攻击行动}
| 结果: 成功 | EXP +12 |
</action_info>
middle
<action_info>
{制作检定}
| 品质: 稀有 | 检定结果: 精益求精 |
</action_info>`, 'message-b');

    expect(html.match(/class="action-panel"/g)).toHaveLength(3);
    expect(html).toContain('aria-controls="message-b-0-0"');
    expect(html).toContain('aria-controls="message-b-0-1"');
    expect(html).toContain('aria-controls="message-b-1-0"');
    expect(html).toContain('class="action-arrow">→');
    expect(html).toContain('class="action-quality rare">稀有');
    expect(html).toContain('class="action-result success">精益求精');
  });

  it('escapes HTML and leaves malformed blocks visible as plain text', () => {
    const closed = renderActionInfoMessage('<script>alert(1)</script><action_info>{面板}\n| 内容: <img src=x onerror=alert(2)> |</action_info>');
    expect(closed).not.toContain('<script>');
    expect(closed).not.toContain('<img');
    expect(closed).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(closed).toContain('&lt;img src=x onerror=alert(2)&gt;');

    const malformed = renderActionInfoMessage('before <action_info>{缺少结束标签}\n| HP 1/2 |');
    expect(malformed).toContain('&lt;action_info&gt;');
    expect(malformed).not.toContain('class="action-panel"');
  });

  it('keeps only combat sections while preserving surrounding narrative', () => {
    const html = renderCombatActionInfoMessage(`before
<action_info>
{角色状态}
| 等级: 1 |
{战况总览}
| 回合: 2 | 环境: 城门 |
{制作检定}
| 检定结果: 成功 |
{戰鬥結算}
| 结果: 胜利 |
</action_info>
after`);
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html).toContain('战况总览');
    expect(html).toContain('戰鬥結算');
    expect(html).not.toContain('角色状态');
    expect(html).not.toContain('制作检定');
    expect(html.match(/class="action-panel"/g)).toHaveLength(2);
  });

  it('removes non-combat blocks and suppresses incomplete streaming blocks', () => {
    const nonCombat = renderCombatActionInfoMessage('before<action_info>{属性}\n| 力量: 3 |</action_info>after');
    expect(nonCombat).toContain('before');
    expect(nonCombat).toContain('after');
    expect(nonCombat).not.toContain('属性');
    expect(nonCombat).not.toContain('action-panel');

    const streaming = renderCombatActionInfoMessage(
      'visible<action_info>{战况总览}\n| 回合: 1 |',
      'stream',
      { suppressIncomplete: true },
    );
    expect(streaming).toContain('visible');
    expect(streaming).not.toContain('action_info');
    expect(streaming).not.toContain('战况总览');
  });
});
