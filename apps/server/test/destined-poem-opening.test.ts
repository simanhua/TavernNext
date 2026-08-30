import { describe, expect, it } from 'vitest';
// The official Scene server module is a framework-free native ES module.
// @ts-expect-error The runtime asset has no declaration file.
import destinedPoemServer, { DESTINED_POEM_OPENING_IDS } from '../assets/official-scenes/destined-poem/server/index.mjs';

const playerProfile = { name: '艾琳', description: '来自云端的见证者' };

describe('Destined Poem opening initialization', () => {
  it('keeps custom starts location-driven and asks the player to define the opening', async () => {
    const result = await destinedPoemServer.initializeConversation({
      setup: { opening: 'custom', origin: '梵尼亚' },
      playerProfile,
    });

    expect(result.initialState.世界.地点).toBe('梵尼亚');
    expect(result.initialState.事件).toMatchObject({ 开启: false, 标题: '', 阶段: '等待落笔' });
    expect(result.initialState.主角).toMatchObject({ 姓名: '艾琳', 描述: '来自云端的见证者' });
    expect(result.openingMessages[0].content).toContain('命运的书页已经翻开');
    expect(result.openingMessages[0].content).toContain('第一条消息');
  });

  it.each([
    ['summoned-hero', '无光的第四位勇者', '布劳尔子爵领', '被召唤的勇者', 500],
    ['lost-shore', '失亡彼岸的重逢', '泣空遗迹', '漂泊者', 200],
    ['divine-party', '神恩日的不速之客', '万象神殿', '冒险者', 0],
  ])('initializes the %s fixed opening atomically', async (opening, title, location, identity, fate) => {
    const result = await destinedPoemServer.initializeConversation({
      setup: { opening, origin: '不应覆盖固定舞台' },
      playerProfile,
    });

    expect(result.initialState.事件.标题).toBe(title);
    expect(result.initialState.世界.地点).toContain(location);
    expect(result.initialState.主角.身份).toContain(identity);
    expect(result.initialState.主角.属性.力量).toBeGreaterThan(0);
    expect(result.initialState.命运点数).toBe(fate);
    expect(result.openingMessages[0].content.length).toBeGreaterThan(120);
  });

  it('seeds the original Floro relationship only for the Lost Shore opening', async () => {
    const lostShore = await destinedPoemServer.initializeConversation({
      setup: { opening: 'lost-shore', origin: 'ignored' },
      playerProfile,
    });
    const summoned = await destinedPoemServer.initializeConversation({
      setup: { opening: 'summoned-hero', origin: 'ignored' },
      playerProfile,
    });

    expect(lostShore.initialState.关系列表.弗洛洛).toMatchObject({
      姓名: '弗洛洛', 在场: true, 好感度: 49, 命定契约: true,
    });
    expect(summoned.initialState.关系列表).not.toHaveProperty('弗洛洛');
    expect(DESTINED_POEM_OPENING_IDS).toEqual(['custom', 'summoned-hero', 'lost-shore', 'divine-party']);
  });
});
