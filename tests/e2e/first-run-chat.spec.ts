import { expect, test, type Page } from '@playwright/test';
import { fixturePath, startE2eStack, type E2eStack } from './support/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: E2eStack;

test.beforeAll(async () => {
  stack = await startE2eStack();
});

test.afterAll(async () => {
  await stack?.close();
});

async function importThroughDialog(page: Page, buttonName: string, fixture: string) {
  await page.getByRole('button', { name: buttonName }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Choose a file').setInputFiles(fixturePath(fixture));
  await expect(dialog.getByRole('button', { name: 'Commit import' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Commit import' }).click();
  await expect(dialog).toBeHidden();
}

test('a first-run user can configure, import, chat, stop, branch, edit, delete, and preview locally', async ({ page }) => {
  stack.provider.queue({ chunks: ['First ', 'answer'] });
  stack.provider.queue({ chunks: ['Swiped answer'] });
  stack.provider.queue({ chunks: ['Regenerated answer'] });
  stack.provider.queue({ chunks: [' + continued'] });
  stack.provider.queue({ chunks: [' + stopped partial'], hold: true });

  await page.goto('/connection');
  await page.getByLabel('Display name').fill('Local Mock');
  await page.getByLabel('Base URL').fill(`${stack.provider.baseUrl}/v1`);
  await page.getByLabel('Model').fill('mock-model');
  await page.getByLabel('API key').fill('e2e-local-key');
  await page.locator('select[name="apiMode"]').selectOption('chat');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connection saved with an API key');

  await page.getByRole('link', { name: 'Characters' }).click();
  await page.getByRole('button', { name: 'New Character' }).click();
  await page.getByLabel('Name').fill('E2E Aster');
  await page.getByLabel('Description').fill('A deterministic local character.');
  await page.getByLabel('First message').fill('Ready for the local test.');
  await page.getByRole('button', { name: 'Create Character' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Aster' })).toBeVisible();
  await importThroughDialog(page, 'Import Character', 'characters/v3.json');
  await expect(page.getByRole('heading', { name: 'V3 Aster' })).toBeVisible();

  await page.getByRole('link', { name: 'Personas' }).click();
  await page.getByRole('button', { name: 'New Persona' }).click();
  await page.getByLabel('Name').fill('E2E Traveler');
  await page.getByLabel('Description').fill('A local test persona.');
  await page.getByLabel('Default Persona').check();
  await page.getByRole('button', { name: 'Create Persona' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Traveler' })).toBeVisible();

  await page.getByRole('link', { name: 'Presets' }).click();
  await importThroughDialog(page, 'Import Preset', 'presets/chat/synthetic-chat.settings');
  await expect(page.getByRole('heading', { name: 'Synthetic Chat Settings' })).toBeVisible();

  await page.getByRole('link', { name: 'Worldbooks' }).click();
  await importThroughDialog(page, 'Import Worldbook', 'worldbooks/native.json');
  await expect(page.getByRole('heading', { name: 'Native Synthetic Lore' })).toBeVisible();

  await page.getByRole('link', { name: 'Chat' }).click();
  await page.getByLabel('Character').selectOption({ label: 'E2E Aster' });
  await page.getByLabel('Persona').selectOption({ label: 'E2E Traveler' });
  await page.getByLabel('Provider').selectOption({ label: 'Local Mock' });
  await page.getByLabel('Chat preset').selectOption({ label: 'Synthetic Chat Settings' });
  await page.locator('#chat-draft').fill('Open the local gate');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('First answer');
  await expect(page.getByLabel('Response variants')).toContainText('1 / 1');

  await page.locator('#chat-draft').fill('Preview without generating');
  await page.getByRole('button', { name: 'Preview prompt' }).click();
  const preview = page.getByRole('dialog', { name: 'Prompt Preview' });
  await expect(preview.getByRole('heading', { name: 'Chat prompt' })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Tokenizer' })).toBeVisible();
  await preview.getByRole('button', { name: 'Close Prompt Preview' }).click();
  await page.locator('#chat-draft').fill('');

  await page.getByRole('button', { name: 'Swipe response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Swiped answer');
  await expect(page.getByLabel('Response variants')).toContainText('2 / 2');

  await page.getByRole('button', { name: 'Regenerate response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Regenerated answer');
  await expect(page.getByLabel('Response variants')).toContainText('3 / 3');

  await page.getByRole('button', { name: 'Continue response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Regenerated answer + continued');

  await page.getByRole('button', { name: 'Continue response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('stopped partial');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.generation-status')).toHaveText('idle');
  await expect(page.locator('article.message-assistant').last()).toContainText('Regenerated answer + continued + stopped partial');

  const userMessage = page.locator('article.message-user').first();
  await userMessage.getByRole('button', { name: /^Edit / }).click();
  await userMessage.getByLabel('Edit message').fill('Edited local gate question');
  await userMessage.getByRole('button', { name: 'Save edit' }).click();
  await expect(userMessage).toContainText('Edited local gate question');
  await userMessage.getByRole('button', { name: /^Delete / }).click();
  await expect(page.locator('article.message-user')).toHaveCount(0);

  expect(stack.provider.requests.map(({ path }) => path)).toEqual([
    '/v1/chat/completions',
    '/v1/chat/completions',
    '/v1/chat/completions',
    '/v1/chat/completions',
    '/v1/chat/completions',
  ]);
});
