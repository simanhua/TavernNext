import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Conversation } from '@tavernnext/domain';
import type { CreateInput, Repositories } from '../src/db/repositories.js';
import { createSaveAgentConfiguration } from '../src/services/save-agent-configuration-service.js';
import { createSaveWorldbook } from '../src/services/save-worldbook-service.js';

/** A complete synthetic Scene Save graph for API and generation tests; no legacy HTTP path. */
export function createTestSceneSave(
  repositories: Repositories,
  input: CreateInput<Conversation>,
  options: { presetId?: string; state?: Record<string, unknown>; sourceWorldbookId?: string } = {},
): Conversation {
  const character = repositories.characters.get(input.characterId);
  if (character === undefined) throw new Error('test_character_missing');
  const presetId = options.presetId ?? repositories.globalGenerationConfig.get().chatPresetId
    ?? repositories.presets.create({
      id: randomUUID(), name: 'Test Scene style', kind: 'chat',
      settings: {
        prompts: [{ identifier: 'style', role: 'system', content: 'Write concise roleplay prose.' }],
        prompt_order: [{ character_id: character.id, order: [{ identifier: 'style', enabled: true }] }],
      },
    }).id;
  const sceneId = input.sceneId ?? randomUUID();
  if (repositories.installedScenes.get(sceneId) === undefined) repositories.installedScenes.create({
    id: sceneId, slug: 'test-scene-' + sceneId, version: '1.0.0', archiveDigest: 'a'.repeat(64),
    installPath: tmpdir(), installedAt: new Date().toISOString(),
    manifest: {
      id: sceneId, slug: 'test-scene-' + sceneId, version: '1.0.0', name: 'Test Scene', summary: '',
      description: '', author: 'TavernNext', minimumTavernNextVersion: '1.0.0', sceneSdkVersion: 2,
      frontendEntry: 'frontend.js', frontendStyles: [], setupSchema: {}, stateSchema: {},
      agentTools: [], sceneViews: [], files: ['frontend.js'],
    },
    backingCharacterId: character.id, backingPresetId: presetId,
  });
  const conversation = repositories.conversations.create({ ...input, sceneId });
  const state = options.state ?? {};
  repositories.conversationSceneStates.create({
    id: randomUUID(), conversationId: conversation.id, schemaVersion: 1,
    baseValue: state, value: state, headTransitionId: null,
  });
  createSaveWorldbook(repositories, conversation, options.sourceWorldbookId ?? character.worldbookId);
  createSaveAgentConfiguration(repositories, conversation.id, presetId);
  return conversation;
}
