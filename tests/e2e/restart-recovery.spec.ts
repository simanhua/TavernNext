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

test('a server restart restores the selected assistant variant from the same data directory', async ({ page }) => {
  const characterId = await importArtifact(stack.baseUrl, 'characters/v3.json');
  const persona = await apiJson<any>(stack.baseUrl, '/api/personas', {
    method: 'POST', body: { id: crypto.randomUUID(), name: 'Restart Traveler', description: '', isDefault: true },
  });
  const conversationId = await importArtifact(stack.baseUrl, 'chats/swipes.jsonl', {
    characterId, personaId: persona.id, title: 'Restart recovery chat',
  });
  const before = await apiJson<any>(stack.baseUrl, `/api/conversations/${conversationId}/messages`);
  const assistant = before.messages.find((message: any) => message.role === 'assistant');
  const selected = assistant.variants[2];
  await apiJson(stack.baseUrl, `/api/messages/${assistant.id}/active-variant`, {
    method: 'PUT', body: { revision: assistant.revision, variantId: selected.id },
  });

  await stack.restartServer();

  const restored = await apiJson<any>(stack.baseUrl, `/api/conversations/${conversationId}/messages`);
  const restoredAssistant = restored.messages.find((message: any) => message.role === 'assistant');
  expect(restoredAssistant.activeVariantId).toBe(restoredAssistant.variants[2].id);
  expect(restoredAssistant.variants[2].content).toBe('The third door opens.');

  await page.goto('/');
  await page.getByLabel('Conversation').selectOption(conversationId);
  await expect(page.locator('article.message-assistant')).toContainText('The third door opens.');
  await expect(page.getByLabel('Response variants')).toContainText('3 / 3');
});
