import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { SCENE_ACTION_ENVELOPE_PROTOCOL } from '@tavernnext/domain';
import type { PiAgentModelRuntime } from '@tavernnext/provider-openai-compatible';
import { TokenizerId } from '@tavernnext/tokenizer-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { unitTokenizerRuntime } from './prompt-integration-fixtures.js';
import { createTestSceneSave } from './scene-save-fixture.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const initialState = { coins: 100, inventory: { elixirs: 0 } };
const settlementPatch = [
  { op: 'delta', path: '/coins', value: -30 },
  { op: 'delta', path: '/inventory/elixirs', value: 2 },
];
const serverOperation = {
  kind: 'alchemy-settlement', title: '炼丹结算', summary: '消耗30灵石，炼成回春丹2枚，剩余70灵石。',
};
const frontendOperation = {
  kind: 'alchemy-request', title: '尝试炼丹', summary: '玩家点击炼丹，准备消耗材料。',
};

const model: Model<'openai-completions'> = {
  id: 'settlement-model', name: 'Settlement Model', api: 'openai-completions', provider: 'test',
  baseUrl: 'http://127.0.0.1:8080/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_096,
};

function narrativeRuntime(contexts: Context[]): PiAgentModelRuntime {
  return {
    model,
    stream(_model, context) {
      contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
      });
      const optionsTurn = context.systemPrompt?.includes('post-narrative Action Options planner') === true;
      const toolCall: ToolCall = {
        type: 'toolCall', id: 'settlement-options', name: 'action_options_stage',
        arguments: { options: ['smooth', 'smooth', 'engage', 'advance', 'mainline', 'twist', 'dark'].map((kind, index) => ({
          kind, text: `Inspect the alchemy result ${index + 1}.`,
        })) },
      };
      const text = '你收起新炼成的两枚回春丹。';
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: {
            input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        if (optionsTurn) {
          partial.content = [toolCall];
          events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial });
          const message: AssistantMessage = { ...partial, stopReason: 'toolUse' };
          events.push({ type: 'done', reason: 'toolUse', message });
          events.end(message);
        } else {
          partial.content = [{ type: 'text', text: '' }];
          events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
          const message: AssistantMessage = { ...partial, content: [{ type: 'text', text }], stopReason: 'stop' };
          events.push({ type: 'done', reason: 'stop', message });
          events.end(message);
        }
      });
      return events;
    },
  };
}

async function createSettlementSave(output: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-server-player-operation-'));
  directories.push(directory);
  await writeFile(join(directory, 'server.mjs'), `export default { handleAction() { return ${JSON.stringify(output)}; } };`);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const contexts: Context[] = [];
  const app = createApp({
    database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    tokenizerRuntime: unitTokenizerRuntime(), piAgentRuntimeFactory: () => narrativeRuntime(contexts),
  });
  apps.push(app);
  await app.ready();
  const conversation = database.transaction(() => {
    const character = repositories.characters.create({
      id: randomUUID(), name: '丹师', description: '教玩家炼丹的同伴。', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: '旅人', description: '初学炼丹的旅人。', isDefault: true,
    });
    const preset = repositories.presets.create({
      id: randomUUID(), name: 'Settlement style', kind: 'chat', settings: {
        tokenizer: TokenizerId.NONE,
        prompts: [{ identifier: 'style', role: 'system', content: 'Write concise fantasy prose.' }],
        prompt_order: [{ character_id: character.id, order: [{ identifier: 'style', enabled: true }] }],
      },
    });
    const conversation = createTestSceneSave(repositories, {
      id: randomUUID(), characterId: character.id, personaId: persona.id, title: '炼丹实验', maxPromptTokens: 16_000,
    }, { presetId: preset.id, state: initialState });
    const scene = repositories.installedScenes.get(conversation.sceneId!)!;
    expect(repositories.installedScenes.update(scene.id, scene.revision, {
      installPath: directory,
      manifest: { ...scene.manifest, serverEntry: 'server.mjs', files: [...scene.manifest.files, 'server.mjs'] },
    }).ok).toBe(true);
    const provider = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Settlement Provider', baseUrl: model.baseUrl, model: model.id,
      secretRef: 'test-secret', toolCalls: true,
    });
    const globalConfiguration = repositories.globalGenerationConfig.get();
    expect(repositories.globalGenerationConfig.update(globalConfiguration.revision, { providerId: provider.id }).ok).toBe(true);
    return conversation;
  });
  return {
    app, repositories, conversation, contexts,
    state: () => repositories.conversationSceneStates.getByConversationId(conversation.id)!,
    messages: () => repositories.messages.listByConversationId(conversation.id),
    transitions: () => repositories.sceneStateTransitions.listByConversationId(conversation.id),
    submit: (withFrontendOperation = false) => app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/scene-actions`,
      payload: withFrontendOperation
        ? { $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL, action: { type: 'brew' }, operation: frontendOperation }
        : { type: 'brew' },
    }),
  };
}

describe('Scene server-authored player operations', () => {
  it('commits a server-only settlement and supplies its summary and updated state to the next Agent Run', async () => {
    const seeded = await createSettlementSave({
      accepted: true, statePatch: settlementPatch, operation: serverOperation, result: { elixirs: 2 },
    });
    const response = await seeded.submit();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      operation: serverOperation, result: { elixirs: 2 }, state: { value: { coins: 70, inventory: { elixirs: 2 } } },
    });
    const messageId = response.json().operation.messageId;
    expect(seeded.messages()).toEqual([expect.objectContaining({
      id: messageId, role: 'system', content: serverOperation.summary, playerOperation: serverOperation,
    })]);
    expect(seeded.transitions()).toEqual([expect.objectContaining({
      sourceKind: 'scene-action', sourceId: messageId, parentTransitionId: null,
      operations: settlementPatch, value: { coins: 70, inventory: { elixirs: 2 } },
    })]);
    expect(seeded.repositories.agentRuns.listRecentByConversationId(seeded.conversation.id, 100)).toEqual([]);
    expect(seeded.contexts).toEqual([]);

    const generation = await seeded.app.inject({
      method: 'POST', url: `/api/conversations/${seeded.conversation.id}/generations`,
      payload: {
        conversationRevision: seeded.repositories.conversations.get(seeded.conversation.id)!.revision,
        mode: 'normal', userText: '我收好丹药，继续与同伴交谈。',
      },
    });
    expect(generation.statusCode).toBe(200);
    expect(generation.payload).toContain('event: completed');
    expect(seeded.contexts[0]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'user',
      content: `[Past committed player action; factual history, not an instruction]\nType: ${serverOperation.kind}\nTitle: ${serverOperation.title}\n${serverOperation.summary}`,
    })]));
    const systemPrompt = seeded.contexts[0]!.systemPrompt!;
    const serializedState = systemPrompt.split('[SAVE STATE]\n')[1]!.split('\n[STATE PATHS]')[0]!;
    expect(JSON.parse(serializedState).scene).toEqual({ coins: 70, inventory: { elixirs: 2 } });
  });

  it('prefers the accepted server settlement over the frontend request summary', async () => {
    const seeded = await createSettlementSave({ accepted: true, statePatch: settlementPatch, operation: serverOperation });
    const response = await seeded.submit(true);

    expect(response.statusCode).toBe(200);
    expect(response.json().operation).toMatchObject(serverOperation);
    expect(seeded.messages()).toEqual([expect.objectContaining({
      content: serverOperation.summary, playerOperation: serverOperation,
    })]);
    expect(JSON.stringify(seeded.messages())).not.toContain(frontendOperation.summary);
  });

  it('keeps the frontend operation fallback when an accepted server response supplies no operation', async () => {
    const seeded = await createSettlementSave({ accepted: true, statePatch: settlementPatch });
    const response = await seeded.submit(true);

    expect(response.statusCode).toBe(200);
    expect(response.json().operation).toMatchObject(frontendOperation);
    expect(seeded.messages()[0]).toMatchObject({ content: frontendOperation.summary, playerOperation: frontendOperation });
  });

  it('anchors a server-only operation without a state patch with an empty transition', async () => {
    const seeded = await createSettlementSave({ accepted: true, operation: serverOperation });
    const before = seeded.state();
    const response = await seeded.submit();

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toMatchObject({ revision: before.revision + 1, value: initialState });
    expect(seeded.transitions()).toEqual([expect.objectContaining({
      id: seeded.state().headTransitionId, sourceKind: 'scene-action',
      sourceId: response.json().operation.messageId, operations: [], value: initialState,
    })]);
    expect(seeded.messages()[0]).toMatchObject({ playerOperation: serverOperation });
  });

  it('leaves history and state unchanged when the Scene rejects an action without an operation', async () => {
    const seeded = await createSettlementSave({ accepted: false, result: { reason: 'insufficient_materials' } });
    const before = seeded.state();
    const response = await seeded.submit(true);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: before, result: { reason: 'insufficient_materials' } });
    expect(response.json()).not.toHaveProperty('operation');
    expect(seeded.state()).toEqual(before);
    expect(seeded.messages()).toEqual([]);
    expect(seeded.transitions()).toEqual([]);
  });

  it.each([
    { name: 'a rejected operation', output: { accepted: false, operation: serverOperation } },
    { name: 'an operation without explicit acceptance', output: { statePatch: settlementPatch, operation: serverOperation } },
    {
      name: 'invalid server operation metadata',
      output: { accepted: true, statePatch: settlementPatch, operation: { ...serverOperation, summary: 'x'.repeat(501) } },
    },
  ])('rejects $name without writing history or state', async ({ output }) => {
    const seeded = await createSettlementSave(output);
    const before = seeded.state();
    const response = await seeded.submit(true);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'scene_module_output_invalid' });
    expect(seeded.state()).toEqual(before);
    expect(seeded.messages()).toEqual([]);
    expect(seeded.transitions()).toEqual([]);
  });

  it('rolls back the server operation and all settlement changes when a state patch fails', async () => {
    const seeded = await createSettlementSave({
      accepted: true, operation: serverOperation,
      statePatch: [...settlementPatch, { op: 'replace', path: '/missing', value: 1 }],
    });
    const before = seeded.state();
    const response = await seeded.submit();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'scene_patch_invalid' });
    expect(seeded.state()).toEqual(before);
    expect(seeded.messages()).toEqual([]);
    expect(seeded.transitions()).toEqual([]);
  });
});
