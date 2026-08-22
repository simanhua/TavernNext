import { expect, test } from '@playwright/test';
import { apiJson, importArtifact, startE2eStack, type E2eStack } from './support/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: E2eStack;

test.beforeAll(async () => { stack = await startE2eStack(); });
test.afterAll(async () => { await stack?.close(); });

test('attached compatibility release gate stays offline and crosses import, trust, generation, MVU, reasoning, actions, and reload', async ({ page }) => {
  const ids = {
    provider: '018f0000-0000-7000-8000-000000005001',
    persona: '018f0000-0000-7000-8000-000000005002',
    conversation: '018f0000-0000-7000-8000-000000005003',
  };
  const characterId = await importArtifact(stack.baseUrl, 'characters/attached-release.json');
  const presetId = await importArtifact(stack.baseUrl, 'presets/attached-release.settings');
  await apiJson(stack.baseUrl, `/api/extension-trust/character/${characterId}/grant`, { method: 'POST' });
  await apiJson(stack.baseUrl, `/api/extension-trust/preset/${presetId}/grant`, { method: 'POST' });
  await apiJson(stack.baseUrl, '/api/providers', { method: 'POST', body: {
    id: ids.provider, name: 'Release provider', baseUrl: `${stack.provider.baseUrl}/v1`,
    model: 'mock-model', apiMode: 'chat', apiKey: 'release-secret',
  } });
  await apiJson(stack.baseUrl, '/api/personas', { method: 'POST', body: {
    id: ids.persona, name: 'Release traveler', description: '', isDefault: true,
  } });
  await apiJson(stack.baseUrl, '/api/settings/generation', { method: 'PATCH', body: {
    revision: 0, patch: { providerId: ids.provider, chatPresetId: presetId },
  } });
  await apiJson(stack.baseUrl, '/api/conversations', { method: 'POST', body: {
    id: ids.conversation, characterId, personaId: ids.persona, title: 'Attached release gate',
    maxPromptTokens: 8_192, maxResponseTokens: 512,
  } });
  stack.provider.queue({ chunks: [
    '<think>Release reasoning</think><gametxt>Generated release reply</gametxt>',
    '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/world/location","value":"generated"}]</JSONPatch></UpdateVariable>',
    '\n<StatusPlaceHolderImpl/>',
  ] });
  stack.provider.queue({ chunks: ['<gametxt>Button reply</gametxt>\n<StatusPlaceHolderImpl/>'] });

  await page.goto('/');
  await page.getByLabel('Conversation').selectOption(ids.conversation);
  await expect(page.locator('iframe.interactive-message-frame')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Release Action' })).toBeVisible();
  await page.locator('#chat-draft').fill('Release gate request');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('article.message-assistant')).toHaveCount(2);
  await expect(page.locator('article.message-assistant').last()).toContainText('Generated release reply');
  await expect(page.locator('article.message-assistant').last().locator('.mes_reasoning')).toContainText('Release reasoning');
  await expect(page.locator('article.message-assistant').first().locator('iframe.interactive-message-frame')).toHaveCount(1);
  await expect(page.locator('article.message-assistant').last().locator('iframe.interactive-message-frame')).toHaveCount(1);

  const providerRequest = stack.provider.requests.find(({ path }) => path === '/v1/chat/completions');
  expect(providerRequest).toBeDefined();
  const providerBody = providerRequest!.body as { model?: string; messages?: Array<{ role: string; content: string }>; stop?: string[] };
  expect(providerBody.model).toBe('mock-model');
  expect(providerBody.stop).toContain('Participant:');
  expect(providerBody.messages).toHaveLength(1);
  expect(providerBody.messages?.[0]).toMatchObject({ role: 'user' });
  expect(providerBody.messages?.[0]?.content).toContain('Participant:Release gate request');
  expect(JSON.stringify(providerBody)).not.toContain('release-secret');

  const detail = await apiJson<{ messages: Array<{ role: string; activeVariantId: string | null }> }>(
    stack.baseUrl, `/api/conversations/${ids.conversation}/messages`,
  );
  const generated = [...detail.messages].reverse().find((message) => message.role === 'assistant')!;
  const state = await apiJson<{ value: { stat_data: { world: { location: string } } } }>(
    stack.baseUrl, `/api/runtime-states/message-variant/${generated.activeVariantId!}`,
  );
  expect(state.value.stat_data.world.location).toBe('generated');

  await page.getByRole('button', { name: 'Release Action' }).click();
  await expect(page.locator('article.message-assistant')).toHaveCount(3);
  await expect(page.locator('article.message-assistant').last()).toContainText('Button reply');
  await page.reload();
  await page.getByLabel('Conversation').selectOption(ids.conversation);
  await expect(page.locator('article.message-assistant')).toHaveCount(3);
  await expect(page.locator('iframe.interactive-message-frame')).toHaveCount(3);
  expect(stack.provider.requests.filter(({ path }) => path === '/v1/chat/completions')).toHaveLength(2);
});
