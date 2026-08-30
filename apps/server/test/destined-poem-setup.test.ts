import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySceneWorldbookEntryOverrides } from '../src/services/prompt-snapshot-service.js';
// Browser-native Scene module without declaration files.
// @ts-expect-error Runtime asset is plain JavaScript.
import { calculateDestinedPoemBuild, toggleDestinedPoemDlc } from '../assets/official-scenes/destined-poem/frontend/setup.mjs';
// Server-native Scene module without declaration files.
// @ts-expect-error Runtime asset is plain JavaScript.
import { DESTINED_POEM_SETUP_CATALOG, initializeCustomOpening, readerCoreBeforeGeneration, READER_CORE_EFFECTIVE_CONTENT, worldbookOverridesForSetup } from '../assets/official-scenes/destined-poem/server/setup.mjs';

const initialState = () => JSON.parse(readFileSync(
  new URL('../assets/official-scenes/destined-poem/content/initial-state.json', import.meta.url),
  'utf8',
));
const core = DESTINED_POEM_SETUP_CATALOG.cores.find((item: { label: string }) => item.label === 'null核心');

function build() {
  return {
    gender: '女', age: 20, race: '人类', identity: '非贵族平民',
    location: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德', level: 2,
    basePoints: { 力量: 5, 敏捷: 5, 体质: 5, 智力: 5, 精神: 5 },
    attributePoints: { 力量: 1, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 },
    reincarnationPoints: 1_000, destinyPoints: 20, money: 500,
    equipments: ['精铁长剑'], items: ['微弱生命药剂'], skills: ['火焰箭'], partners: ['艾琳'],
    customSelections: [], customPartners: [], background: '日常', backgroundDescription: '',
  };
}

describe('Destined Poem original-card setup catalog', () => {
  it('pins the complete 1.8.2 selection catalogs', () => {
    expect(DESTINED_POEM_SETUP_CATALOG.sourceVersion).toBe('1.8.2');
    expect(DESTINED_POEM_SETUP_CATALOG.cores).toHaveLength(23);
    expect(DESTINED_POEM_SETUP_CATALOG.dlcs).toHaveLength(61);
    expect(Object.values(DESTINED_POEM_SETUP_CATALOG.partners).flat()).toHaveLength(13);
    expect(Object.values(DESTINED_POEM_SETUP_CATALOG.equipments).flat()).toHaveLength(417);
    expect(Object.values(DESTINED_POEM_SETUP_CATALOG.items).flat()).toHaveLength(171);
    expect(Object.values(DESTINED_POEM_SETUP_CATALOG.skills).flat()).toHaveLength(470);
  });

  it('uses the original reincarnation-point accounting rules', () => {
    const result = calculateDestinedPoemBuild(DESTINED_POEM_SETUP_CATALOG, build());
    expect(result.remainingBase).toBe(0);
    expect(result.remainingExtra).toBe(0);
    expect(result.finalAttributes).toEqual({ 力量: 6, 敏捷: 5, 体质: 5, 智力: 5, 精神: 5 });
    expect(result.consumed).toBe(158);
    expect(result.remaining).toBe(842);
  });

  it('enforces DLC prerequisites without mutating unrelated selections', () => {
    const snow = DESTINED_POEM_SETUP_CATALOG.dlcs.find((item: { label: string }) => item.label === '傲雪');
    const dragonborn = DESTINED_POEM_SETUP_CATALOG.dlcs.find((item: { label: string }) => item.label === '东方龙裔');
    const blocked = toggleDestinedPoemDlc(DESTINED_POEM_SETUP_CATALOG, new Set(), snow.key);
    expect(blocked.error).toContain('东方龙裔');
    expect(blocked.selected.has(snow.key)).toBe(false);
    const allowed = toggleDestinedPoemDlc(DESTINED_POEM_SETUP_CATALOG, new Set([dragonborn.key]), snow.key);
    expect(allowed.error).toBeUndefined();
    expect(allowed.selected).toEqual(new Set([dragonborn.key, snow.key]));
  });

  it('initializes attributes, inventory, skills, companions, and background atomically', () => {
    const state = initialState();
    const result = initializeCustomOpening(state, { opening: 'custom', origin: 'ignored', build: build() }, {
      name: '伊蕾娜', description: '旅行中的见证者',
    });
    expect(result).toMatchObject({ consumedPoints: 158, reincarnationPoints: 1_000 });
    expect(state.世界.地点).toContain('艾瑟嘉德');
    expect(state.主角).toMatchObject({
      姓名: '伊蕾娜', 性别: '女', 年龄: 20, 种族: '人类', 身份: ['非贵族平民'], 等级: 2,
      属性: { 力量: 6, 敏捷: 5, 体质: 5, 智力: 5, 精神: 5 }, 金钱: 500,
    });
    expect(state.主角.装备).toHaveProperty('精铁长剑');
    expect(state.主角.背包).toHaveProperty('微弱生命药剂');
    expect(state.主角.技能).toHaveProperty('火焰箭');
    expect(state.关系列表.艾琳).toMatchObject({ 在场: true, 命定契约: true, 好感度: 25 });
    expect(result.openingMessage).toContain('日常');
  });

  it('creates Save-local overrides for the selected core, DLC groups, and opening-required lore', () => {
    const violet = DESTINED_POEM_SETUP_CATALOG.dlcs.find((item: { label: string }) => item.label === '维奥莱塔');
    const overrides = worldbookOverridesForSetup({ core: core.entryComment, dlcKeys: [violet.key] }, 'lost-shore');
    const enabled = new Map(overrides.map((item: { comment: string; enabled: boolean }) => [item.comment, item.enabled]));
    expect(DESTINED_POEM_SETUP_CATALOG.cores.filter((item: { entryComment: string }) => enabled.get(item.entryComment))).toEqual([core]);
    for (const comment of violet.entryComments) expect(enabled.get(comment)).toBe(true);
    expect(enabled.get('[弗洛洛角色卡DLC(彼岸花开局必开/作者十七）]')).toBe(true);
    expect(overrides.every((item: { source: string }) => item.source === 'character')).toBe(true);
  });

  it('projects Save-local entry overrides without mutating the shared Worldbook template', () => {
    const entries = [
      { comment: '命定系统-null核心(H一串)', displayName: '', enabled: false },
      { comment: '命定系统-薇洛核心(银莳萝)', displayName: '', enabled: true },
      { comment: '[mvu_update]output_format (使用额外模型更新变量开)', displayName: '', enabled: true },
    ];
    const source = { source: 'character', book: { entries } };
    const projected = applySceneWorldbookEntryOverrides(source as never, [
      { source: 'character', comment: entries[0]!.comment, enabled: true },
      { source: 'character', comment: entries[1]!.comment, enabled: false },
    ]).book.entries;
    expect(projected.map((entry) => entry.enabled)).toEqual([true, false, false]);
    expect(entries.map((entry) => entry.enabled)).toEqual([false, true, true]);
  });

  it('materializes the Reader core instead of sending raw EJS to the model', () => {
    const reader = DESTINED_POEM_SETUP_CATALOG.cores.find((item: { label: string }) => item.label === '读者核心');
    const overrides = worldbookOverridesForSetup({ core: reader.entryComment, dlcKeys: [] }, 'custom');
    const readerOverride = overrides.find((item: { comment: string }) => item.comment === reader.entryComment);
    expect(readerOverride).toMatchObject({ enabled: true, content: READER_CORE_EFFECTIVE_CONTENT });
    expect(readerOverride.content).toContain('<reader-core-effective>');
    expect(readerOverride.content).not.toContain('<%');

    const state = initialState();
    const before = readerCoreBeforeGeneration(state, reader.entryComment);
    expect(before.statePatch.map((operation: { path: string }) => operation.path)).toEqual([
      '/主角/技能/间章:小憩',
      '/主角/技能/故事的主人',
      '/主角/状态效果/九十九夜梦·读者核心',
    ]);
  });
});
