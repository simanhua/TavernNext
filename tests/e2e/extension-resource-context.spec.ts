import { expect, test } from '@playwright/test';
import { startE2eStack, type E2eStack } from './support/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: E2eStack;

test.beforeAll(async () => {
  stack = await startE2eStack();
});

test.afterAll(async () => {
  await stack?.close();
});

test('Current Context follows the primary Preset and active Conversation Character', async ({ page }) => {
  const ids = {
    provider: '018f0000-0000-7000-8000-000000003001',
    firstPreset: '018f0000-0000-7000-8000-000000003002',
    secondPreset: '018f0000-0000-7000-8000-000000003003',
    firstCharacter: '018f0000-0000-7000-8000-000000003004',
    secondCharacter: '018f0000-0000-7000-8000-000000003005',
    persona: '018f0000-0000-7000-8000-000000003006',
    firstConversation: '018f0000-0000-7000-8000-000000003007',
    secondConversation: '018f0000-0000-7000-8000-000000003008',
  };
  await page.request.post('/api/providers', { data: {
    id: ids.provider, name: 'Context provider', baseUrl: `${stack.provider.baseUrl}/v1`,
    model: 'mock-model', apiMode: 'chat', apiKey: 'local-test-key',
  } });
  for (const [id, name] of [[ids.firstPreset, 'First preset'], [ids.secondPreset, 'Second preset']] as const) {
    await page.request.post('/api/presets', { data: { id, name, kind: 'chat', settings: { prompts: [], prompt_order: [] } } });
  }
  for (const [id, name] of [[ids.firstCharacter, 'First character'], [ids.secondCharacter, 'Second character']] as const) {
    await page.request.post('/api/characters', { data: {
      id, name, description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    } });
  }
  await page.request.post('/api/personas', { data: {
    id: ids.persona, name: 'Context persona', description: '', isDefault: true,
  } });
  await page.request.post('/api/conversations', { data: {
    id: ids.firstConversation, characterId: ids.firstCharacter, personaId: ids.persona, title: 'First context chat',
  } });
  await page.request.post('/api/conversations', { data: {
    id: ids.secondConversation, characterId: ids.secondCharacter, personaId: ids.persona, title: 'Second context chat',
  } });
  await page.request.patch('/api/settings/generation', { data: {
    revision: 0, patch: { providerId: ids.provider, chatPresetId: ids.firstPreset },
  } });
  for (const [kind, id, name] of [
    ['preset', ids.firstPreset, 'First preset regex'],
    ['preset', ids.secondPreset, 'Second preset regex'],
  ] as const) {
    await page.request.put(`/api/extension-assets?ownerKind=${kind}&ownerId=${id}`, { data: {
      ownerRevision: 0,
      assets: [{
        kind: 'regex', sourceKey: name, ordinal: 0, enabled: false, diagnostics: [],
        payload: { id: name, scriptName: name, disabled: true, findRegex: '/x/g', replaceString: 'y', placement: [2] },
      }],
    } });
  }
  for (const [kind, id, name] of [
    ['character', ids.firstCharacter, 'First character script'],
    ['character', ids.secondCharacter, 'Second character script'],
  ] as const) {
    await page.request.put(`/api/extension-assets?ownerKind=${kind}&ownerId=${id}`, { data: {
      ownerRevision: 0,
      assets: [{
        kind: 'tavern_helper', sourceKey: name, ordinal: 0, enabled: true, diagnostics: [],
        payload: { id: name, type: 'script', name, enabled: true, content: '' },
      }],
    } });
  }

  await page.goto('/');
  await page.getByLabel('Conversation').selectOption(ids.firstConversation);
  await page.getByRole('link', { name: 'Attached Resources' }).click();
  await expect(page.getByRole('button', { name: /First character script.*Untrusted/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Regexes 1' }).click();
  await expect(page.getByRole('button', { name: /First preset regex.*Disabled/ })).toBeVisible();

  await page.getByRole('link', { name: 'Connection' }).click();
  await page.getByLabel('Chat Preset').selectOption(ids.secondPreset);
  await page.getByRole('button', { name: 'Save active generation configuration' }).click();
  await page.getByRole('link', { name: 'Attached Resources' }).click();
  await page.getByRole('tab', { name: 'Regexes 1' }).click();
  await expect(page.getByRole('button', { name: /Second preset regex.*Disabled/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /First preset regex/ })).toHaveCount(0);

  await page.getByRole('link', { name: 'Chat' }).click();
  await page.getByLabel('Conversation').selectOption(ids.secondConversation);
  await page.getByRole('link', { name: 'Attached Resources' }).click();
  await expect(page.getByRole('button', { name: /Second character script.*Untrusted/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /First character script/ })).toHaveCount(0);

  await page.getByRole('tab', { name: 'All Resources' }).click();
  await expect(page.getByRole('tab', { name: 'Scripts 2' })).toBeVisible();
  await page.getByLabel('Search resources').fill('First');
  await page.getByLabel('Source kind').selectOption('character');
  await expect(page.getByRole('tab', { name: 'Scripts 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: /First character script.*Inactive source.*Enabled.*Untrusted/ })).toBeVisible();
});
