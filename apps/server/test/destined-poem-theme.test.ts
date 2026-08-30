import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally ship as framework-free native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { DESTINED_POEM_OPENINGS, DESTINED_POEM_THEMES, destinedPoemOpeningOptionsMarkup, normalizeDestinedPoemTheme, renderDestinedPoemSidebar } from '../assets/official-scenes/destined-poem/frontend/app.js';

describe('Destined Poem visual themes', () => {
  it('offers the three prototype-inspired choices', () => {
    expect(DESTINED_POEM_THEMES.map((theme: { id: string }) => theme.id)).toEqual([
      'gilded',
      'moonlit',
      'crimson',
    ]);
  });

  it('falls back to the gilded theme for missing or invalid preferences', () => {
    expect(normalizeDestinedPoemTheme('moonlit')).toBe('moonlit');
    expect(normalizeDestinedPoemTheme('unknown')).toBe('gilded');
    expect(normalizeDestinedPoemTheme(null)).toBe('gilded');
  });

  it('uses one permanent status surface and vector settings controls', () => {
    const source = readFileSync(new URL('../assets/official-scenes/destined-poem/frontend/app.js', import.meta.url), 'utf8');
    expect(source).not.toContain('status-rail-toggle');
    expect(source).not.toContain('ui.statusRail.mount');
    expect(source).toContain('class="poem-ui-icon"');
  });

  it('integrates every detailed status category into the permanent sidebar', () => {
    const markup = renderDestinedPoemSidebar({
      世界: { 地点: '梵尼亚', 时间: '清晨', 天气: '微风' },
      主角: {
        姓名: '风信子', 种族: '人类', 职业: ['剑士'], 生命层级: '第一层级', 等级: 2,
        冒险者等级: '青铜', 属性点: 1, 金钱: 12,
        生命值: 80, 生命值上限: 100, 法力值: 30, 法力值上限: 50,
        体力值: 40, 体力值上限: 60, 累计经验值: 20, 升级所需经验: 120,
        属性: { 力量: 3, 敏捷: 4, 体质: 3, 智力: 2, 精神: 2 },
        状态效果: { 祝福: { 剩余: 2 } }, 装备: { 铁剑: {} }, 技能: { 剑术: {} }, 背包: { 药水: {} },
      },
      命运点数: 3,
      任务列表: { 初见: { description: '完成登记' } },
    });
    for (const label of ['生命', '法力', '体力', '经验', '梵尼亚', '清晨', '微风', '青铜', '基础属性', '状态效果', '装备', '技能', '背包', '任务']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('data-sidebar-attribute="力量"');
    expect(markup.match(/data-sidebar-section=/g)).toHaveLength(6);
    expect(markup).toContain('data-sidebar-section="equipment" open');
  });
});

describe('Destined Poem opening choices', () => {
  it('preserves the six original card choices and marks its two placeholders unavailable', () => {
    expect(DESTINED_POEM_OPENINGS.map((opening: { id: string }) => opening.id)).toEqual([
      'custom',
      'summoned-hero',
      'red-moon-oath',
      'lost-shore',
      'merciful-demon-king',
      'divine-party',
    ]);
    expect(DESTINED_POEM_OPENINGS.filter((opening: { available: boolean }) => opening.available)).toHaveLength(4);
    expect(DESTINED_POEM_OPENINGS.filter((opening: { available: boolean }) => !opening.available)
      .map((opening: { id: string }) => opening.id)).toEqual(['red-moon-oath', 'merciful-demon-king']);
  });

  it('renders one selected playable choice and disables unfinished original-card placeholders', () => {
    const markup = destinedPoemOpeningOptionsMarkup('lost-shore');
    expect(markup).toContain('data-opening="lost-shore" aria-pressed="true"');
    expect(markup).toContain('失亡彼岸');
    expect(markup).toContain('data-opening="red-moon-oath" aria-pressed="false" disabled');
    expect(markup.match(/尚未完成/g)).toHaveLength(2);
    expect(markup.match(/data-opening=/g)).toHaveLength(6);
  });
});
