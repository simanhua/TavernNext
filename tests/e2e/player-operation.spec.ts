import { expect, test } from '@playwright/test';
import { startE2eStack, type E2eStack } from './support/stack.js';

const sceneId = '018f2000-0000-7000-8000-000000000001';
const sceneLabId = '018f2000-0000-7000-8000-000000000002';
let stack: E2eStack;

test.beforeAll(async () => { stack = await startE2eStack(); });
test.afterAll(async () => { await stack?.close(); });

test('commits a Scene Workspace action, renders its event card, and does not start the Agent', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  expect((await page.request.post(`/api/scenes/${sceneId}/install`)).ok()).toBe(true);
  const created = await page.request.post(`/api/scenes/${sceneId}/conversations`, {
    data: {
      title: '玩家操作验证',
      playerProfile: { name: '艾琳', description: '云端归来的见证者' },
      setup: { opening: 'summoned-hero', core: 'none', dlcKeys: [], origin: 'ignored' },
    },
  });
  expect(created.ok()).toBe(true);
  const conversation = await created.json() as { id: string };
  const current = await page.request.get(`/api/conversations/${conversation.id}/scene-state`);
  const state = await current.json() as { revision: number; value: { 主角: { 属性: { 力量: number } } } };
  const prepared = await page.request.patch(`/api/conversations/${conversation.id}/scene-state`, {
    data: {
      revision: state.revision,
      patch: [{ op: 'replace', path: '/主角/属性点', value: 1 }],
    },
  });
  expect(prepared.ok()).toBe(true);

  await page.goto(`/scene-runtime/${sceneId}/conversations/${conversation.id}`);
  const increaseStrength = page.getByRole('button', { name: '增加力量' });
  await expect(increaseStrength).toBeEnabled();
  await increaseStrength.click();
  await expect(page.locator('.player-operation-card')).toContainText('玩家确认将一点属性分配给力量');

  const timeline = await page.request.get(`/api/conversations/${conversation.id}/messages`);
  const messages = (await timeline.json() as {
    messages: Array<{ role: string; playerOperation?: unknown }>;
  }).messages;
  expect(messages.filter((message) => message.playerOperation !== undefined)).toHaveLength(1);
  expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  const finalState = await page.request.get(`/api/conversations/${conversation.id}/scene-state`);
  expect((await finalState.json()).value.主角).toMatchObject({
    属性点: 0,
    属性: { 力量: state.value.主角.属性.力量 + 1 },
  });
});

test('exposes the complete Player Operation SDK flow in Scene Lab', async ({ page }) => {
  await page.goto('/');
  expect((await page.request.post(`/api/scenes/${sceneLabId}/install`)).ok()).toBe(true);
  const created = await page.request.post(`/api/scenes/${sceneLabId}/conversations`, {
    data: {
      title: '观察实验', playerProfile: { name: '观察者', description: '' },
      setup: { experimentName: '观察实验' },
    },
  });
  expect(created.ok()).toBe(true);
  const conversation = await created.json() as { id: string };

  await page.goto(`/scene-runtime/${sceneLabId}/conversations/${conversation.id}`);
  await page.getByRole('button', { name: '确认记录当前观察' }).click();
  await expect(page.locator('.scene-lab-operation')).toContainText('玩家确认记录当前观察');
});
