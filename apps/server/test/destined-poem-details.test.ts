// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally stay framework-free and ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { bindDestinedPoemDetails, normalizeDestinedPoemDetail, renderDestinedPoemDetailDialog, renderDestinedPoemDetailRow } from '../assets/official-scenes/destined-poem/frontend/details.mjs';

describe('Destined Poem collection details', () => {
  it('normalizes equipment and skill ranks without discarding their distinct fields', () => {
    const equipment = normalizeDestinedPoemDetail('equipment', {
      name: '星落长剑',
      raw: {
        品质: '史诗', 类型: '长剑', 标签: ['双手', '魔导'],
        效果: { '星辉共鸣': '魔法伤害提升' }, 描述: '剑脊中封存着坍落的星光。', 位置: '双手',
      },
    });
    const skill = normalizeDestinedPoemDetail('skill', {
      name: '灰烬轮舞',
      raw: { 品阶: '传说', 类型: '主动技能', 消耗: '30 MP', 效果: { '灼烧': '持续 3 回合' } },
    });
    const quest = normalizeDestinedPoemDetail('quest', {
      name: '寻找失落的诗篇',
      raw: { status: 'active', description: '前往旧教堂寻找残页。', reward: { 金币: 120, 声望: 5 } },
    });

    expect(equipment).toMatchObject({ kindLabel: '装备', rarity: { id: 'epic', label: '史诗' }, type: '长剑' });
    expect(equipment.effects).toEqual([{ label: '星辉共鸣', value: '魔法伤害提升' }]);
    expect(equipment.fields).toContainEqual({ label: '位置', value: '双手' });
    expect(skill).toMatchObject({ kindLabel: '技能', rarity: { id: 'legendary', label: '传说' }, consume: '30 MP' });
    expect(quest).toMatchObject({ kindLabel: '任务', rarity: { id: 'unknown', label: '未定品阶' } });
    expect(quest.fields).toEqual([
      { label: 'status', value: 'active' },
      { label: 'reward', value: '金币：120；声望：5' },
    ]);
    expect(renderDestinedPoemDetailRow(quest, 'quest', 0)).toContain('data-poem-detail="quest-0"');
  });

  it('renders a dedicated detail button and rarity-driven archive card', () => {
    const item = { name: '秘仪斑纹蛋', raw: { 品质: '神话', 类型: '道具', 数量: 2, 描述: '内部盛着未知的生命律动。' } };
    const row = renderDestinedPoemDetailRow(item, 'inventory', 0);
    const dialog = renderDestinedPoemDetailDialog({ inventory: [item] });

    expect(row).toContain('data-poem-detail="inventory-0"');
    expect(row).toContain('详情');
    expect(row).toContain('rarity-mythic');
    expect(dialog).toContain('data-poem-detail-card="inventory-0"');
    expect(dialog).toContain('×2');
    expect(dialog).toContain('品阶</b>神话');
  });

  it('opens the matching card and closes through either dialog action', () => {
    const host = document.createElement('div');
    const item = { name: '草药膏', raw: { 品质: '普通', 类型: '消耗品' } };
    host.innerHTML = `${renderDestinedPoemDetailRow(item, 'inventory', 0)}${renderDestinedPoemDetailDialog({ inventory: [item] })}`;
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    dialog.showModal = undefined as never;
    dialog.close = undefined as never;

    bindDestinedPoemDetails(host);
    host.querySelector<HTMLButtonElement>('[data-poem-detail]')!.click();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.querySelector<HTMLElement>('[data-poem-detail-card]')!.hidden).toBe(false);

    dialog.querySelector<HTMLButtonElement>('[data-poem-detail-close]')!.click();
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});
