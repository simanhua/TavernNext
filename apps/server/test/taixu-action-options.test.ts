import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally stay framework-free and ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { parseTaixuActionOptions, renderTaixuActionOptions, stripTaixuActionOptions, taixuActionOptionsForMessages } from '../assets/official-scenes/taixu-chronicles/frontend/action-options.mjs';

describe('Taixu generated action options', () => {
  it('parses the final complete SUOT block and caps it at seven concise choices', () => {
    const content = `正文。
<SUOT>
1. 顺着石阶继续上山
2、向守门弟子询问试炼规矩
并说明自己是散修
3) 暂时退到雨棚观察
4：检查测灵石附近的阵纹
5. 与楚霁寒交换情报
6．留意丹阁来客
7. 收敛气息，准备测试
8. 不应显示的额外选项
</SUOT>`;

    expect(parseTaixuActionOptions(content)).toEqual([
      '顺着石阶继续上山',
      '向守门弟子询问试炼规矩 并说明自己是散修',
      '暂时退到雨棚观察',
      '检查测灵石附近的阵纹',
      '与楚霁寒交换情报',
      '留意丹阁来客',
      '收敛气息，准备测试',
    ]);
  });

  it('removes complete option payloads from visible prose but leaves malformed tags inert', () => {
    expect(stripTaixuActionOptions('正文\n<SUOT>\n1. A\n2. B\n</SUOT>\n尾声')).toBe('正文\n\n尾声');
    const malformed = '正文\n<SUOT>\n1. 尚未结束';
    expect(parseTaixuActionOptions(malformed)).toEqual([]);
    expect(stripTaixuActionOptions(malformed)).toBe(malformed);
  });

  it('uses only the latest active assistant variant and falls back when it has no valid options', () => {
    const prior = {
      role: 'assistant', activeVariantId: 'old',
      variants: [{ id: 'old', content: '<SUOT>\n1. 旧一\n2. 旧二\n</SUOT>' }],
    };
    const latest = {
      role: 'assistant', activeVariantId: 'selected',
      variants: [
        { id: 'other', content: '<SUOT>\n1. 未选一\n2. 未选二\n</SUOT>' },
        { id: 'selected', document: { blocks: [{ type: 'markdown', content: '<SUOT>\n1. 新一\n2. 新二\n</SUOT>' }] } },
      ],
    };
    expect(taixuActionOptionsForMessages([prior, latest])).toEqual(['新一', '新二']);
    expect(taixuActionOptionsForMessages([prior, { role: 'assistant', content: '没有选项' }])).toEqual([]);
  });

  it('escapes generated choice text before placing it in buttons and data attributes', () => {
    const html = renderTaixuActionOptions(['<script>never()</script> "继续"', '安全选项']);
    expect(html).toContain('data-choice-source="generated"');
    expect(html).toContain('&lt;script&gt;never()&lt;/script&gt; &quot;继续&quot;');
    expect(html).not.toContain('<script>');
    expect(html.match(/data-choice=/g)).toHaveLength(2);
  });
});
