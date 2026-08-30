import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally ship as framework-free native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { attributeAllocationAction, createDestinedPoemStatusRailModel } from '../assets/official-scenes/destined-poem/frontend/status-rail.mjs';

const state = {
  世界: { 地点: '梵尼亚', 时间: '正午' },
  主角: {
    姓名: '<风信子>', 种族: '人类', 身份: ['异邦旅人'], 职业: ['剑士'],
    生命层级: '第一层级/普通', 等级: 2, 累计经验值: 10, 升级所需经验: 120,
    冒险者等级: '未评级', 属性点: 1,
    属性: { 力量: 3, 敏捷: 4, 体质: 3, 智力: 2, 精神: 2 },
    生命值: 80, 生命值上限: 100, 法力值: 20, 法力值上限: 40,
    体力值: 30, 体力值上限: 50, 金钱: 80,
    状态效果: { 祝福: { 剩余: 2 } },
    装备: { 旧铁剑: { 品质: '普通', 攻击: 15 } },
    技能: { 基础剑术: { 类型: '主动', 效果: '<script>bad()</script>' } },
    背包: { 药水: { 数量: 2 } },
  },
  命运点数: 3,
};

describe('Destined Poem status rail renderer', () => {
  it('maps canonical status into the reusable platform model', () => {
    const model = createDestinedPoemStatusRailModel(state, 'fallback');
    expect(model.ariaLabel).toBe('角色状态栏');
    expect(model.tabs).toHaveLength(4);
    expect(model.title).toBe('<风信子>');
    expect(JSON.stringify(model.tabs[0])).toContain('梵尼亚');
    expect(JSON.stringify(model.tabs[0])).toContain('生命');
    expect(JSON.stringify(model.tabs[0])).toContain('可用点数 1');
    expect(JSON.stringify(model.tabs[0])).toContain('命运点数');
  });

  it('maps dynamic equipment, skills, and inventory without owning their schema', () => {
    const model = createDestinedPoemStatusRailModel(state);
    const tab = (id: string) => model.tabs.find((item: { id: string }) => item.id === id);
    expect(JSON.stringify(tab('equipment'))).toContain('旧铁剑');
    expect(JSON.stringify(tab('skills'))).toContain('基础剑术');
    expect(JSON.stringify(tab('skills'))).toContain('<script>bad()</script>');
    expect(JSON.stringify(tab('inventory'))).toContain('药水');
  });

  it('provides explicit empty states and an Agent-visible attribute operation', () => {
    const model = createDestinedPoemStatusRailModel({ 主角: {} });
    const tab = (id: string) => model.tabs.find((item: { id: string }) => item.id === id);
    expect(JSON.stringify(tab('equipment'))).toContain('暂无装备记录');
    expect(JSON.stringify(tab('skills'))).toContain('暂无技能记录');
    expect(JSON.stringify(tab('inventory'))).toContain('背包为空');
    expect(attributeAllocationAction('敏捷')).toEqual({
      action: { type: 'allocate-attribute', attribute: '敏捷' },
      options: { operation: {
        kind: 'attribute-allocation',
        title: '属性分配',
        summary: '玩家确认将一点属性分配给敏捷。',
      } },
    });
    expect(() => attributeAllocationAction('幸运')).toThrow('attribute_allocation_invalid');
  });
});
