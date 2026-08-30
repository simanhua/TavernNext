import { expect, test } from '@playwright/test';
import { startE2eStack, type E2eStack } from './support/stack.js';

let stack: E2eStack;

test.beforeAll(async () => { stack = await startE2eStack(); });
test.afterAll(async () => { await stack?.close(); });

test('creates a Taixu Save, changes its workspace, and commits one generated state update', async ({ page }) => {
  test.setTimeout(120_000);
  stack.provider.queue({
    toolCalls: [{
      name: 'taixu_adjust_cultivation',
      arguments: { amount: 3, reason: '在问心坪吐纳水行灵气' },
    }],
  });
  stack.provider.queue({ chunks: ['测灵石余光散去，楚霁寒将翻涌的灵息重新压回丹田。'] });

  await page.goto('/settings');
  await page.getByLabel('Display name').fill('Taixu Mock');
  await page.getByLabel('Base URL').fill(`${stack.provider.baseUrl}/v1`);
  await page.getByLabel('Model', { exact: true }).fill('mock-model');
  await page.getByLabel('Model supports tool calls').check();
  await page.getByLabel('API key').fill('taixu-e2e-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connection saved');
  await page.getByLabel('Active Provider').selectOption({ label: 'Taixu Mock' });
  await page.getByRole('button', { name: 'Save active Provider' }).click();

  await page.goto('/');
  const catalogCard = page.locator('article.scene-card').filter({ hasText: '太虚问道' });
  await expect(catalogCard).toBeVisible({ timeout: 30_000 });
  const install = catalogCard.getByRole('button', { name: '安装官方场景' });
  if (await install.count() > 0) await install.click();
  const card = page.getByRole('link', { name: /太虚问道/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  const [scene] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '创建新存档' }).click(),
  ]);

  await expect(scene.getByRole('heading', { name: '从何处落笔' })).toBeVisible();
  await scene.getByRole('button', { name: /同路问山/ }).click();
  await scene.getByLabel('称谓').fill('沈照微');
  await scene.getByLabel('身份与来历').fill('与楚霁寒同行三月的剑修');
  await scene.getByRole('button', { name: '玄藏主题' }).click();
  await scene.getByRole('button', { name: /立下此卷/ }).click();

  await expect(scene).toHaveURL(/\/scene-runtime\/.*\/conversations\//);
  await expect(scene.locator('main.tx-workspace')).toHaveClass(/theme-xuanzang/);
  await scene.getByRole('button', { name: '丹霞主题' }).click();
  await expect(scene.locator('main.tx-workspace')).toHaveClass(/theme-danxia/);
  await scene.getByRole('button', { name: /混沌命盘/ }).click();
  await expect(scene.getByRole('heading', { name: '混沌命盘' })).toBeVisible();
  await scene.getByRole('button', { name: /浮生录/ }).click();

  await expect(scene.locator('[data-chapter-event="water-root-test"]')).toBeVisible();
  await scene.getByRole('button', { name: /接受测灵石检验/ }).click();
  await expect(scene.locator('[data-chapter-event="concealment-check"]')).toBeVisible();
  await expect(scene.locator('.tx-chapter')).toContainText('太虚仙宗·问心坪');

  await scene.locator('#tx-draft').fill('在问心坪吐纳片刻，稳住水行灵息。');
  await scene.getByRole('button', { name: '遣' }).click();
  await expect(scene.getByText('测灵石余光散去，楚霁寒将翻涌的灵息重新压回丹田。')).toBeVisible({ timeout: 30_000 });
  await scene.getByRole('button', { name: /混沌命盘/ }).click();
  await expect(scene.locator('.tx-fate-core')).toContainText('75%');
  await expect(scene.locator('body')).not.toContainText('taixu-e2e-key');
});
