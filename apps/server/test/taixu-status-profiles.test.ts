import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally stay framework-free and ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { normalizeTaixuStatusProfiles, renderTaixuStatusProfile, renderTaixuStatusTabs, taixuSecretIdentity } from '../assets/official-scenes/taixu-chronicles/frontend/status-profiles.mjs';

describe('Taixu status profiles', () => {
  it('normalizes a legacy Save into player and Chu Jihan status profiles', () => {
    const result = normalizeTaixuStatusProfiles({
      楚霁寒: {
        姓名: '楚霁寒', 公开身份: '水灵根散修',
        境界: { 名称: '金丹', 阶段: '中期', 进度: 72 },
        灵根: { 对外: '水属性单灵根', 真实: '太古混沌灵根' },
        背包: ['青铜古戒', '青锋长剑'],
        功法: ['太虚混元功·基础篇'],
      },
      关系: { player: { 好感: 20 } },
    }, { name: '风信子', description: '同行散修' });

    expect(result.affinity).toBe(20);
    expect(result.player).toMatchObject({ name: '风信子', identity: '同行散修' });
    expect(result.character).toMatchObject({ name: '楚霁寒', rank: '金丹·中期' });
    expect(result.character.items.map((item: { name: string }) => item.name)).toContain('青铜古戒');
    expect(result.character.skills.map((item: { name: string }) => item.name)).toContain('太虚混元功·基础篇');
    expect(result.taixuzi).toMatchObject({
      key: 'taixuzi', name: '太虚子', rank: '残魂·状态未明', progress: 0,
    });
    expect(result.taixuzi.items.map((item: { name: string }) => item.name)).toContain('寄魂青铜古戒');
    expect(result.taixuzi.skills.map((item: { name: string }) => item.name)).toContain('残魂接管');
  });

  it('covers hidden items and skills until the relationship threshold is met', () => {
    const profile = normalizeTaixuStatusProfiles({
      楚霁寒: {
        状态栏物品: [{ id: 'ring', 名称: '青铜古戒', 品阶: '未知', 描述: '戒中另有乾坤', 解锁好感: 30 }],
        状态栏技能: [{ id: 'root', 名称: '太古混沌灵根', 品阶: '绝密', 描述: '十系同源', 解锁好感: 160 }],
      },
      关系: { player: { 好感: 29 } },
    }, { name: '旅人', description: '' }).character;
    const locked = renderTaixuStatusProfile(profile, { affinity: 29, privateProfile: true });
    expect(locked).toContain('当前好感度不足');
    expect(locked).toContain('29 / 30');
    expect(locked).toContain('tx-status-entry locked');

    const unlocked = renderTaixuStatusProfile(profile, { affinity: 160, privateProfile: true });
    expect(unlocked).not.toContain('当前好感度不足');
    expect(unlocked).toContain('青铜古戒');
    expect(unlocked).toContain('太古混沌灵根');
  });

  it('uses the same affinity rule for the compact secret identity', () => {
    expect(taixuSecretIdentity({ 真实: '太古混沌灵根' }, 159)).toEqual({ locked: true, label: '命格未解' });
    expect(taixuSecretIdentity({ 真实: '太古混沌灵根' }, 160)).toEqual({ locked: false, label: '太古混沌灵根' });
  });

  it('renders Taixuzi as a companion subtab with soul-state details and locked secrets', () => {
    const profile = normalizeTaixuStatusProfiles({
      太虚子: { 状态: '清醒', 魂力: 72, 可接管次数: 1, 沉睡至: '', 还魂丹进度: 4 },
      关系: { player: { 好感: 10 } },
    }).taixuzi;

    const tabs = renderTaixuStatusTabs('taixuzi');
    const markup = renderTaixuStatusProfile(profile, { affinity: 10, privateProfile: true });
    expect(tabs).toContain('data-status-subject="chu-jihan"');
    expect(tabs).toContain('data-status-subject="taixuzi" class="active"');
    expect(markup).toContain('data-status-profile="taixuzi"');
    expect(markup).toContain('残魂·清醒');
    expect(markup).toContain('还魂丹进度');
    expect(markup).toContain('当前好感度不足');
    expect(markup.match(/tx-status-entry locked/g)).toHaveLength(7);
  });
});
