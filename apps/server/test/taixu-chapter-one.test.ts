import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { TAIXU_CHRONICLES_SCENE_ID } from '../src/scenes/official-package.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Taixu Chronicles chapter one', () => {
  it('starts the sect trial with a deterministic water-root test', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-taixu-chapter-one-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();

    expect((await app.inject({
      method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/install`,
    })).statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/conversations`,
      payload: {
        title: '同路问山', playerProfile: { name: '沈照微', description: '同行剑修' },
        setup: {
          opening: 'traveling-companion', loreDetail: 'concise', relationshipMode: 'adventure-focus',
          redThread: 'none', contentMode: 'general', theme: 'xuanqing',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id as string;
    const initial = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/scene-state` });
    expect(initial.json().value).toMatchObject({
      第一章: { 阶段: '前往太虚仙宗', 当前事件: 'water-root-test', 已完成事件: [] },
    });

    const event = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: { type: 'chapter-event', eventId: 'water-root-test' },
    });
    expect(event.statusCode).toBe(200);
    expect(event.json()).toMatchObject({
      result: { ok: true, eventId: 'water-root-test', nextEvent: 'concealment-check' },
      state: { value: {
        世界: { 地点: '太虚仙宗·问心坪', 章节: '第一章·叩问山门' },
        第一章: { 当前事件: 'concealment-check', 已完成事件: ['water-root-test'] },
      } },
    });

    const skipped = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: { type: 'chapter-event', eventId: 'first-clue' },
    });
    expect(skipped.json()).toMatchObject({
      result: { ok: false, code: 'chapter_event_out_of_order', expected: 'concealment-check' },
      state: { value: { 第一章: { 当前事件: 'concealment-check' } } },
    });

    const concealment = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: { type: 'chapter-event', eventId: 'concealment-check' },
    });
    expect(concealment.json()).toMatchObject({
      result: { ok: true, eventId: 'concealment-check', nextEvent: 'taixuzi-first-spend' },
      state: { value: {
        楚霁寒: { 暴露风险: 12 },
        第一章: {
          当前事件: 'taixuzi-first-spend',
          藏拙判定: '成功·测灵石仅显露水属性单灵根',
          已完成事件: ['water-root-test', 'concealment-check'],
        },
      } },
    });

    const soulSpend = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: { type: 'chapter-event', eventId: 'taixuzi-first-spend' },
    });
    expect(soulSpend.json()).toMatchObject({
      result: { ok: true, eventId: 'taixuzi-first-spend', nextEvent: 'meet-talent' },
      state: { value: {
        太虚子: { 魂力: 64, 状态: '短暂虚弱' },
        第一章: {
          当前事件: 'meet-talent',
          已完成事件: ['water-root-test', 'concealment-check', 'taixuzi-first-spend'],
        },
      } },
    });

    const meeting = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: { type: 'chapter-event', eventId: 'meet-talent' },
    });
    expect(meeting.json()).toMatchObject({
      result: { ok: true, eventId: 'meet-talent', nextEvent: 'first-clue' },
      state: { value: {
        关系: {
          'shen-hantang': {
            姓名: '沈寒棠', 关系: '同届试炼者·丹阁真传', 好感: 18, 阶段: '路人',
          },
        },
        第一章: {
          当前事件: 'first-clue',
          已完成事件: ['water-root-test', 'concealment-check', 'taixuzi-first-spend', 'meet-talent'],
        },
      } },
    });

    const clue = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: { type: 'chapter-event', eventId: 'first-clue' },
    });
    expect(clue.json()).toMatchObject({
      result: { ok: true, eventId: 'first-clue', nextEvent: 'completed' },
      state: { value: {
        世界: { 地点: '太虚仙宗·外门临时居所', 章节: '第一章·山门留名' },
        楚霁寒: { 公开身份: '太虚仙宗外门记名弟子' },
        第一章: {
          阶段: '已获得临时身份', 当前事件: 'completed',
          已完成事件: [
            'water-root-test', 'concealment-check', 'taixuzi-first-spend', 'meet-talent', 'first-clue',
          ],
        },
        长生局: {
          目标: '在外门站稳脚跟，查明测灵石五行残响的来源',
          线索: [{
            id: 'spirit-stone-fivefold-echo',
            标题: '测灵石中的五行残响',
            详情: '太虚子遮掩灵根时，测灵石内部回应了不属于当代阵纹的五行轮转。',
          }],
        },
        任务: {
          'enter-taixu': { 状态: 'completed' },
          'outer-sect-foothold': { 标题: '外门藏锋', 状态: 'active' },
        },
      } },
    });
  }, 30_000);
});
