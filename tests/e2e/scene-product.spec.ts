import { expect, test } from '@playwright/test';
import { startE2eStack, type E2eStack } from './support/stack.js';

test.describe.configure({ mode: 'serial' });
let stack: E2eStack;

test.beforeAll(async () => { stack = await startE2eStack(); });
test.afterAll(async () => { await stack?.close(); });

test('runs two isolated Scene saves in trusted top-level tabs', async ({ page }) => {
  test.setTimeout(120_000);
  stack.provider.queue({ chunks: ['正在生成的片段'], hold: true });
  stack.provider.queue({ chunks: [
    '钟声回荡，命运向前推进。<UpdateVariable><JSONPatch>[{"op":"replace","path":"/命运点数","value":2}]</JSONPatch></UpdateVariable>',
  ] });

  await page.goto('/settings');
  await page.getByLabel('Display name').fill('Local Mock');
  await page.getByLabel('Base URL').fill(`${stack.provider.baseUrl}/v1`);
  await page.getByLabel('Model').fill('mock-model');
  await page.getByLabel('API key').fill('scene-e2e-key');
  await page.locator('select[name="apiMode"]').selectOption('chat');
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
  await firstScene.getByRole('button', { name: '状态' }).click();
  await expect(firstScene.getByText('2', { exact: true })).toBeVisible();
  await expect(firstScene.getByText('梵尼亚', { exact: true })).toBeVisible();

  const [secondScene] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '创建新存档' }).click(),
  ]);
  await secondScene.getByLabel('主角姓名').fill('洛恩');
  await secondScene.getByLabel('开局地点').selectOption('索伦蒂斯王国');
  await secondScene.getByLabel('存档名称').fill('洛恩的海国存档');
  await secondScene.getByRole('button', { name: '创建存档' }).click();
  await expect(secondScene).toHaveURL(/\/scene-runtime\/.*\/conversations\//);
  await secondScene.getByRole('button', { name: '状态' }).click();
  await expect(secondScene.getByText('0', { exact: true })).toBeVisible();
  await expect(secondScene.getByText('索伦蒂斯王国', { exact: true })).toBeVisible();

  const pageCount = page.context().pages().length;
  await expect(page.getByRole('button', { name: /艾琳的梵尼亚存档/ })).toBeVisible();
  await page.getByRole('button', { name: /艾琳的梵尼亚存档/ }).click();
  await expect.poll(() => page.context().pages().length).toBe(pageCount);
});
