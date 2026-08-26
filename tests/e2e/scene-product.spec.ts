import { expect, test } from '@playwright/test';
import { startE2eStack, type E2eStack } from './support/stack.js';

test.describe.configure({ mode: 'serial' });
let stack: E2eStack;

test.beforeAll(async () => { stack = await startE2eStack(); });
test.afterAll(async () => { await stack?.close(); });

test('runs two isolated Scene saves in trusted top-level tabs', async ({ page }) => {
  test.setTimeout(120_000);
  stack.provider.queue({ chunks: ['正在生成的片段'], hold: true });
  stack.provider.queue({ toolCalls: [
    { name: 'destined_poem_adjust_fate', arguments: { amount: 2, reason: '守住档案馆' } },
    { name: 'destined_poem_travel', arguments: { location: '艾瑟嘉德', time: '黄昏' } },
    { name: 'destined_poem_update_relationship', arguments: {
      entityId: 'lyra', name: '莉拉', affinityDelta: 8, description: '并肩守卫档案馆。',
    } },
    { name: 'destined_poem_update_quest', arguments: {
      questId: 'guard_archive', title: '守住档案馆', status: 'completed', description: '噬页兽已经退去。',
    } },
    { name: 'destined_poem_rule_check', arguments: { key: 'archive-vault', difficulty: 10, modifier: 2 } },
    ...['status', 'map', 'relationship', 'progress'].map((kind) => ({
      name: 'scene_view_stage',
      arguments: { kind, relatedEntities: kind === 'relationship' ? ['lyra'] : [], insertionIntent: 'inline' },
    })),
  ] });
  stack.provider.queue((request) => {
    const references = [...new Set(JSON.stringify(request.body).match(/<!--tavernnext:view:[0-9a-f-]+-->/g) ?? [])];
    if (references.length !== 4) throw new Error(`Expected four staged Scene View references, got ${references.length}`);
    return { chunks: [`钟声回荡，命运向前推进。${references.join('随后，')}旅程仍在继续。`] };
  });

  await page.goto('/settings');
  await page.getByLabel('Display name').fill('Local Mock');
  await page.getByLabel('Base URL').fill(`${stack.provider.baseUrl}/v1`);
  await page.getByLabel('Model', { exact: true }).fill('mock-model');
  await page.getByLabel('Model supports tool calls').check();
  await page.getByLabel('API key').fill('scene-e2e-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connection saved');
  await page.getByLabel('Active Provider').selectOption({ label: 'Local Mock' });
  await page.getByRole('button', { name: 'Save active Provider' }).click();

  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: '安装官方场景' }).click();
  const card = page.getByRole('link', { name: /命定之诗与黄昏之歌/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();

  const [firstScene] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '创建新存档' }).click(),
  ]);
  await expect(firstScene.locator('iframe')).toHaveCount(0);
  await firstScene.getByLabel('主角姓名').fill('艾琳');
  await firstScene.getByLabel('主角描述').fill('云端归来的见证者');
  await firstScene.getByLabel('开局地点').selectOption('梵尼亚');
  await firstScene.getByLabel('存档名称').fill('艾琳的梵尼亚存档');
  await firstScene.getByRole('button', { name: '创建存档' }).click();

  await expect(firstScene).toHaveURL(/\/scene-runtime\/.*\/conversations\//);
  await expect(firstScene.getByText('命运的书页已经翻开')).toBeVisible();
  await expect(firstScene.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(firstScene.locator('html')).not.toHaveClass(/dark/);

  await firstScene.getByPlaceholder('你准备做什么？').fill('测试生成反馈');
  await firstScene.getByRole('button', { name: '发送' }).click();
  await expect(firstScene.getByText('正在生成回复…')).toBeVisible();
  await expect(firstScene.getByText('正在生成的片段')).toBeVisible();
  await firstScene.getByRole('button', { name: '停止' }).click();
  await expect(firstScene.getByText('正在生成回复…')).toBeHidden();

  await firstScene.getByPlaceholder('你准备做什么？').fill('沿钟声继续前进');
  await firstScene.getByRole('button', { name: '发送' }).click();
  await expect(firstScene.getByText('钟声回荡，命运向前推进。')).toBeVisible({ timeout: 30_000 });
  await expect(firstScene.getByRole('region', { name: '艾琳状态' })).toBeVisible();
  await expect(firstScene.getByRole('region', { name: '艾瑟嘉德地图' })).toBeVisible();
  await expect(firstScene.getByRole('region', { name: '关系进展' })).toContainText('莉拉');
  await expect(firstScene.getByRole('region', { name: '旅程进展' })).toContainText('守住档案馆');
  await expect(firstScene.getByRole('region', { name: '旅程进展' })).toContainText('completed');
  await expect(firstScene.locator('.tn-status-rail')).toContainText('2');
  await expect(firstScene.locator('.tn-status-rail')).toContainText('艾瑟嘉德');

  await firstScene.reload();
  await expect(firstScene.getByRole('region', { name: '艾琳状态' })).toBeVisible({ timeout: 30_000 });
  await expect(firstScene.getByRole('region', { name: '关系进展' })).toContainText('莉拉');
  stack.provider.queue({ toolCalls: [{
    name: 'destined_poem_rule_check', arguments: { key: 'continue-journey', difficulty: 8, modifier: 1 },
  }] });
  stack.provider.queue({ chunks: ['判定完成后，艾琳继续向皇城深处前进。'] });
  await firstScene.getByPlaceholder('你准备做什么？').fill('继续探索皇城');
  await firstScene.getByRole('button', { name: '发送' }).click();
  await expect(firstScene.getByText('判定完成后，艾琳继续向皇城深处前进。')).toBeVisible({ timeout: 30_000 });

  const [secondScene] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '创建新存档' }).click(),
  ]);
  await secondScene.getByLabel('主角姓名').fill('洛恩');
  await secondScene.getByLabel('开局地点').selectOption('索伦蒂斯王国');
  await secondScene.getByLabel('存档名称').fill('洛恩的海国存档');
  await secondScene.getByRole('button', { name: '创建存档' }).click();
  await expect(secondScene).toHaveURL(/\/scene-runtime\/.*\/conversations\//);
  await expect(secondScene.locator('.tn-status-rail')).toContainText('0');
  await expect(secondScene.locator('.tn-status-rail')).toContainText('索伦蒂斯王国');

  const pageCount = page.context().pages().length;
  const firstSave = page.getByRole('button', { name: /^艾琳的梵尼亚存档/ });
  await expect(firstSave).toBeVisible();
  await firstSave.click();
  await expect.poll(() => page.context().pages().length).toBe(pageCount);
});
