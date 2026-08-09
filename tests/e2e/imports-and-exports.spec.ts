import { expect, test } from '@playwright/test';
import {
  apiJson,
  exportArtifact,
  importArtifact,
  normalizeCharacter,
  normalizeChat,
  normalizePreset,
  normalizeWorldbook,
  startE2eStack,
  type E2eStack,
} from './support/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: E2eStack;
const decoder = new TextDecoder();

function json(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

function jsonl(bytes: Uint8Array): unknown[] {
  return decoder.decode(bytes).trim().split('\n').map((line) => JSON.parse(line));
}

test.beforeAll(async () => {
  stack = await startE2eStack();
});

test.afterAll(async () => {
  await stack?.close();
});

test('edited Character PNG/JSON, Worldbook, Preset, and chat exports normalize identically after a fresh-data re-import', async () => {
  const characterId = await importArtifact(stack.baseUrl, 'characters/v3.json');
  const presetId = await importArtifact(stack.baseUrl, 'presets/chat/synthetic-chat.settings');
  const worldbookId = await importArtifact(stack.baseUrl, 'worldbooks/native.json');
  const persona = await apiJson<any>(stack.baseUrl, '/api/personas', {
    method: 'POST',
    body: {
      id: crypto.randomUUID(), name: 'Round-trip Traveler', description: 'Fresh-data target', isDefault: true,
    },
  });
  const sourceCharacter = await apiJson<any>(stack.baseUrl, `/api/characters/${characterId}`);
  await apiJson(stack.baseUrl, `/api/characters/${characterId}`, {
    method: 'PATCH', body: { revision: sourceCharacter.revision, patch: { description: 'Edited before release export' } },
  });
  const sourceWorldbook = await apiJson<any>(stack.baseUrl, `/api/worldbooks/${worldbookId}`);
  await apiJson(stack.baseUrl, `/api/worldbooks/${worldbookId}`, {
    method: 'PATCH', body: { revision: sourceWorldbook.revision, patch: { description: 'Edited Worldbook export' } },
  });
  const sourcePreset = await apiJson<any>(stack.baseUrl, `/api/presets/${presetId}`);
  await apiJson(stack.baseUrl, `/api/presets/${presetId}`, {
    method: 'PATCH', body: { revision: sourcePreset.revision, patch: { name: 'Edited Chat Preset' } },
  });
  const chatId = await importArtifact(stack.baseUrl, 'chats/swipes.jsonl', {
    characterId, personaId: persona.id, title: 'Edited export chat',
  });
  const sourceChat = await apiJson<any>(stack.baseUrl, `/api/conversations/${chatId}/messages`);
  await apiJson(stack.baseUrl, `/api/messages/${sourceChat.messages[0].id}`, {
    method: 'PATCH', body: { revision: sourceChat.messages[0].revision, patch: { content: 'Edited chat question' } },
  });

  const exports = {
    characterJson: await exportArtifact(stack.baseUrl, `/api/characters/${characterId}/export?format=json-v3`),
    characterPng: await exportArtifact(stack.baseUrl, `/api/characters/${characterId}/export?format=png`),
    worldbook: await exportArtifact(stack.baseUrl, `/api/worldbooks/${worldbookId}/export?format=st-native`),
    preset: await exportArtifact(stack.baseUrl, `/api/presets/${presetId}/export`),
    chat: await exportArtifact(stack.baseUrl, `/api/conversations/${chatId}/export?format=st-jsonl`),
  };
  const expected = {
    character: normalizeCharacter(await apiJson(stack.baseUrl, `/api/characters/${characterId}`)),
    worldbook: normalizeWorldbook(await apiJson(stack.baseUrl, `/api/worldbooks/${worldbookId}`)),
    preset: normalizePreset(await apiJson(stack.baseUrl, `/api/presets/${presetId}`)),
    chat: normalizeChat(await apiJson(stack.baseUrl, `/api/conversations/${chatId}/messages`)),
  };

  await stack.restartWithFreshData();
  const importedJsonCharacterId = await importArtifact(stack.baseUrl, exports.characterJson);
  const importedPngCharacterId = await importArtifact(stack.baseUrl, exports.characterPng);
  const importedWorldbookId = await importArtifact(stack.baseUrl, exports.worldbook);
  const importedPresetId = await importArtifact(stack.baseUrl, exports.preset);
  const destinationPersona = await apiJson<any>(stack.baseUrl, '/api/personas', {
    method: 'POST',
    body: { id: crypto.randomUUID(), name: 'Round-trip Traveler', description: 'Fresh-data target', isDefault: true },
  });
  const importedChatId = await importArtifact(stack.baseUrl, exports.chat, {
    characterId: importedJsonCharacterId, personaId: destinationPersona.id, title: 'Edited export chat',
  });

  const reexports = {
    characterJson: await exportArtifact(stack.baseUrl, `/api/characters/${importedJsonCharacterId}/export?format=json-v3`),
    characterPng: await exportArtifact(stack.baseUrl, `/api/characters/${importedPngCharacterId}/export?format=png`),
    worldbook: await exportArtifact(stack.baseUrl, `/api/worldbooks/${importedWorldbookId}/export?format=st-native`),
    preset: await exportArtifact(stack.baseUrl, `/api/presets/${importedPresetId}/export`),
    chat: await exportArtifact(stack.baseUrl, `/api/conversations/${importedChatId}/export?format=st-jsonl`),
  };

  expect(json(reexports.characterJson.bytes)).toEqual(json(exports.characterJson.bytes));
  expect(reexports.characterPng.bytes).toEqual(exports.characterPng.bytes);
  expect(json(reexports.worldbook.bytes)).toEqual(json(exports.worldbook.bytes));
  expect(json(reexports.preset.bytes)).toEqual(json(exports.preset.bytes));
  expect(jsonl(reexports.chat.bytes)).toEqual(jsonl(exports.chat.bytes));

  expect(normalizeCharacter(await apiJson(stack.baseUrl, `/api/characters/${importedJsonCharacterId}`))).toEqual(expected.character);
  expect(normalizeCharacter(await apiJson(stack.baseUrl, `/api/characters/${importedPngCharacterId}`))).toEqual({
    ...(expected.character as Record<string, unknown>),
    compatibilitySummary: {
      sourceFormat: 'character:png:3.0',
      warnings: ['png_multiple_character_chunks'],
      unknownFieldCount: 2,
    },
  });
  expect(normalizeWorldbook(await apiJson(stack.baseUrl, `/api/worldbooks/${importedWorldbookId}`))).toEqual(expected.worldbook);
  expect(normalizePreset(await apiJson(stack.baseUrl, `/api/presets/${importedPresetId}`))).toEqual(expected.preset);
  expect(normalizeChat(await apiJson(stack.baseUrl, `/api/conversations/${importedChatId}/messages`))).toEqual(expected.chat);
});
