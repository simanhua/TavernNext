import { expect, test } from '@playwright/test';
import { startE2eStack, type E2eStack } from './support/stack.js';

let stack: E2eStack;

test.beforeAll(async () => { stack = await startE2eStack(); });
test.afterAll(async () => { await stack?.close(); });

test('builds an isolated Save from the original-card setup workflow', async ({ page }) => {
  test.setTimeout(120_000);
  let selectedCoreSeen = false;
  stack.provider.queue((request) => {
    const payload = String(JSON.stringify(request.body));
    selectedCoreSeen = payload.includes('<reader-core-effective>') && !payload.includes("getLocalVar('dream_persona')");
    return { toolCalls: [{
      name: 'scene_patch_stage', arguments: { operations: [] },
    }] };
  });
  stack.provider.queue({ chunks: ['九十九夜梦已经来信，旅程由此继续。'] });

  await page.goto('/settings');
  await page.getByLabel('Display name').fill('Setup Mock');
  await page.getByLabel('Base URL').fill(`${stack.provider.baseUrl}/v1`);
  await page.getByLabel('Model', { exact: true }).fill('mock-model');
  await page.getByLabel('Model supports tool calls').check();
  await page.getByLabel('API key').fill('setup-e2e-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connection saved');
  await page.getByLabel('Active Provider').selectOption({ label: 'Setup Mock' });
  await page.getByRole('button', { name: 'Save active Provider' }).click();

  await page.goto('/');
  await page.locator('article.scene-card').filter({ hasText: '命定之诗与黄昏之歌' })
    .getByRole('button', { name: '安装官方场景' }).click();
  const card = page.getByRole('link', { name: /命定之诗与黄昏之歌/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  const [scene] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '创建新存档' }).click(),
  ]);

  await expect(scene.getByRole('heading', { name: '选择命定核心与 DLC' })).toBeVisible();
  await expect(scene.getByLabel('命定核心').locator('option')).toHaveCount(23);
  await scene.getByLabel('命定核心').selectOption('命定系统-读者核心(Angtuck)');
  await expect(scene.getByText('已启用 16 / 61 组')).toBeVisible();

  await scene.locator('[data-stage="character"]').click();
  await scene.getByLabel('主角姓名').fill('伊蕾娜');
  await scene.getByLabel('主角描述').fill('旅行中的见证者');
  await scene.getByLabel('起始地点').selectOption('大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德');

  await scene.locator('[data-stage="selections"]').click();
  await scene.locator('[data-select-kind="equipment"][data-name="精铁长剑"]').click();
  await scene.locator('[data-stage="companions"]').click();
  await scene.locator('[data-partner="艾琳"]').click();

  await scene.locator('[data-stage="confirm"]').click();
  await expect(scene.getByText('1 项')).toBeVisible();
  await expect(scene.getByText('1 名同伴')).toBeVisible();
  await scene.getByLabel('存档名称').fill('伊蕾娜的完整开局');
  await scene.getByRole('button', { name: '创建存档' }).click();

  await expect(scene).toHaveURL(/\/scene-runtime\/.*\/conversations\//);
  await expect(scene.locator('.poem-sidebar')).toContainText('精铁长剑');
  await expect(scene.locator('.poem-sidebar')).toContainText('间章:小憩');
  await expect(scene.locator('.poem-sidebar')).toContainText('九十九夜梦·读者核心');
  await scene.getByRole('button', { name: '关系' }).click();
  await expect(scene.getByText('艾琳', { exact: true }).first()).toBeVisible();
  await scene.getByRole('button', { name: '对话' }).click();
  await scene.getByPlaceholder('你准备做什么？').fill('聆听命定核心的声音');
  const generationResponse = scene.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith('/generations')
  ));
  await scene.getByRole('button', { name: '发送' }).click();
  const started = await generationResponse;
  if (!started.ok()) {
    throw new Error(`Generation failed with ${started.status()}: ${await started.text()}\n${stack.serverLogs.join('')}`);
  }
  await expect(scene.getByText('九十九夜梦已经来信，旅程由此继续。')).toBeVisible({ timeout: 30_000 });
  expect(selectedCoreSeen).toBe(true);
  await expect(scene.locator('body')).not.toContainText('setup-e2e-key');
});
