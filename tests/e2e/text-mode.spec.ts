import { expect, test } from '@playwright/test';
import { apiJson, importArtifact, startE2eStack, type E2eStack } from './support/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: E2eStack;

test.beforeAll(async () => {
  stack = await startE2eStack();
});

test.afterAll(async () => {
  await stack?.close();
});

test('Text mode streams, stops, regenerates, swipes, continues, and survives restart', async ({ page }) => {
  const characterId = await importArtifact(stack.baseUrl, 'characters/v3.json');
  const persona = await apiJson<any>(stack.baseUrl, '/api/personas', {
    method: 'POST',
    body: { id: crypto.randomUUID(), name: 'Text Traveler', description: 'Text-mode E2E persona', isDefault: true },
  });
  const providerId = crypto.randomUUID();
  await apiJson(stack.baseUrl, '/api/providers', {
    method: 'POST',
    body: {
      id: providerId, name: 'Local Text Mock', baseUrl: `${stack.provider.baseUrl}/v1`,
      model: 'mock-text-model', apiMode: 'text', apiKey: 'text-e2e-local-key',
    },
  });
  const textPresetId = await importArtifact(stack.baseUrl, 'presets/text/synthetic-text.json');
  const textPreset = await apiJson<any>(stack.baseUrl, `/api/presets/${textPresetId}`);
  await apiJson(stack.baseUrl, `/api/presets/${textPresetId}`, {
    method: 'PATCH',
    body: { revision: textPreset.revision, patch: { settings: { ...textPreset.settings, tokenizer: 0 } } },
  });
  const contextPresetId = await importArtifact(stack.baseUrl, 'presets/context/synthetic-context.json');
  const instructPresetId = await importArtifact(stack.baseUrl, 'presets/instruct/synthetic-instruct.json');
  const systemPresetId = await importArtifact(stack.baseUrl, 'presets/system/synthetic-system.json');
  await apiJson(stack.baseUrl, '/api/settings/generation', {
    method: 'PATCH',
    body: {
      revision: 0,
      patch: { providerId, textPresetId, contextPresetId, instructPresetId, systemPresetId },
    },
  });

  stack.provider.queue({ chunks: ['Text first'] });
  stack.provider.queue({ chunks: ['Text swipe'] });
  stack.provider.queue({ chunks: ['Text regenerated'] });
  stack.provider.queue({ chunks: [' + continued'] });
  stack.provider.queue({ chunks: [' + stopped'], hold: true });

  await page.goto('/');
  await page.getByLabel('Character').selectOption(characterId);
  await page.getByLabel('Persona').selectOption(persona.id);
  await page.locator('#chat-draft').fill('Open the Text gate');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Text first');

  await page.getByRole('button', { name: 'Swipe response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Text swipe');
  await expect(page.getByLabel('Response variants')).toContainText('2 / 2');

  await page.getByRole('button', { name: 'Regenerate response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Text regenerated');
  await expect(page.getByLabel('Response variants')).toContainText('3 / 3');

  await page.getByRole('button', { name: 'Continue response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('Text regenerated + continued');
  await page.getByRole('button', { name: 'Continue response' }).click();
  await expect(page.locator('article.message-assistant').last()).toContainText('stopped');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.generation-status')).toHaveText('idle');

  expect(stack.provider.requests.map(({ path }) => path)).toEqual(Array(5).fill('/v1/completions'));
  const conversationId = await page.getByLabel('Conversation').inputValue();

  await stack.restartServer();
  await page.reload();
  await page.getByLabel('Conversation').selectOption(conversationId);
  await expect(page.getByLabel('Response variants')).toContainText('3 / 3');
  await expect(page.locator('article.message-assistant').last()).toContainText('Text regenerated + continued + stopped');
});
