import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import type { PiAgentModelRuntime } from '@tavernnext/provider-openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import {
  buildDestinedPoemPackage,
  DESTINED_POEM_SCENE_ID,
  isBundledOfficialScene,
} from '../src/scenes/official-package.js';
import { SceneModuleHost } from '../src/scenes/scene-module-host.js';
import { createSceneAgentToolFactory } from '../src/services/scene-agent-tools.js';
import { createSceneViewRuntimeFactory } from '../src/services/scene-view-runtime.js';
import type { PromptSnapshotPayload } from '../src/services/prompt-snapshot-service.js';
import { TurnWorkspace } from '../src/services/turn-workspace.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';
import { unitTokenizerRuntime } from './prompt-integration-fixtures.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const model: Model<'openai-completions'> = {
  id: 'scene-tool-model', name: 'Scene Tool Model', api: 'openai-completions', provider: 'custom-openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 4_096,
};

const usage = (): Usage => ({
  input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function runtime(contexts: Context[]): PiAgentModelRuntime {
  let turn = 0;
  return {
    model,
    stream(_model, context) {
      contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
        ...(context.tools === undefined ? {} : {
          tools: context.tools.map((tool) => ({
            name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
          })),
        }),
      });
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (turn++ === 0) {
          const toolCall = {
            type: 'toolCall' as const,
            id: 'fate-1',
            name: 'destined_poem_adjust_fate',
            arguments: { amount: 3, reason: 'SECRET-TOOL-ARGUMENT' },
          };
          const partial: AssistantMessage = {
            role: 'assistant', content: [toolCall], api: model.api, provider: model.provider,
            model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now(),
          };
          events.push({ type: 'start', partial });
          events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial });
          const message: AssistantMessage = { ...partial, stopReason: 'toolUse' };
          events.push({ type: 'done', reason: 'toolUse', message });
          events.end(message);
          return;
        }
        const text = '守住档案馆后，命运的丝线向你偏转。';
        const partial: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api,
          provider: model.provider, model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
        const message: AssistantMessage = {
          ...partial, content: [{ type: 'text', text }], stopReason: 'stop',
        };
        events.push({ type: 'done', reason: 'stop', message });
        events.end(message);
      });
      return events;
    },
  };
}

function viewRuntime(contexts: Context[]): PiAgentModelRuntime {
  let turn = 0;
  return {
    model,
    stream(_model, context) {
      contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
        ...(context.tools === undefined ? {} : {
          tools: context.tools.map((tool) => ({
            name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
          })),
        }),
      });
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (turn++ === 0) {
          const toolCall = {
            type: 'toolCall' as const,
            id: 'view-1',
            name: 'scene_view_stage',
            arguments: { kind: 'combat', relatedEntities: ['archive_guard'], insertionIntent: 'inline' },
          };
          const partial: AssistantMessage = {
            role: 'assistant', content: [toolCall], api: model.api, provider: model.provider,
            model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now(),
          };
          events.push({ type: 'start', partial });
          events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial });
          const message: AssistantMessage = { ...partial, stopReason: 'toolUse' };
          events.push({ type: 'done', reason: 'toolUse', message });
          events.end(message);
          return;
        }
        const staged = context.messages.find((message) => (
          message.role === 'toolResult' && message.toolName === 'scene_view_stage'
        ));
        const reference = staged?.role === 'toolResult'
          ? (staged.details as { reference: string }).reference
          : '';
        const text = `战斗爆发。${reference}局势仍在变化。`;
        const partial: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api,
          provider: model.provider, model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: '战斗爆发。', partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: reference.slice(0, 12), partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: reference.slice(12, -2), partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: `${reference.slice(-2)}${reference.slice(0, 18)}`, partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: `${reference.slice(18)}局势仍在变化。`, partial });
        const message: AssistantMessage = { ...partial, content: [{ type: 'text', text }], stopReason: 'stop' };
        events.push({ type: 'done', reason: 'stop', message });
        events.end(message);
      });
      return events;
    },
  };
}

function terminal(payload: string) {
  const frame = payload.trim().split(/\r?\n\r?\n/).filter(Boolean).at(-1)!;
  const lines = frame.split(/\r?\n/);
  return {
    event: lines.find((line) => line.startsWith('event: '))?.slice(7),
    data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>,
  };
}

describe('bundled Scene Agent tools', () => {
  it('declares and executes one official Scene tool through the Worker and Turn Workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-agent-tool-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const contexts: Context[] = [];
    let runtimeFactory = () => runtime(contexts);
    const app = createApp({
      database,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      tokenizerRuntime: unitTokenizerRuntime(),
      piAgentRuntimeFactory: () => runtimeFactory(),
      providerClientFactory: () => ({
        listModels: async () => [],
        async *streamChat() {
          yield { type: 'delta' as const, text: ' 战斗余波。' };
          yield { type: 'completed' as const, finishReason: 'stop' };
        },
        async *streamText() {},
      }),
    });
    apps.push(app);
    await app.ready();

    const installed = await app.inject({ method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/install` });
    expect(installed.statusCode).toBe(201);
    expect(installed.json().manifest.agentTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'destined_poem_adjust_fate', parameters: expect.objectContaining({ type: 'object' }),
      }),
      ...[
        'destined_poem_adjust_vitals', 'destined_poem_travel', 'destined_poem_update_relationship',
        'destined_poem_update_quest', 'destined_poem_rule_check',
      ].map((name) => expect.objectContaining({ name })),
    ]));
    const persona = repositories.personas.create({
      id: randomUUID(), name: '见证者', description: '来自旧世界的旅行者。', isDefault: true,
    });
    const created = await app.inject({
      method: 'POST', url: `/api/scenes/${DESTINED_POEM_SCENE_ID}/conversations`,
      payload: {
        title: '官方工具存档', personaTemplateId: persona.id,
        playerProfile: { name: '艾琳', description: persona.description }, setup: { origin: '梵尼亚' },
      },
    });
    expect(created.statusCode).toBe(201);
    const conversation = created.json();
    const provider = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Agent Provider', baseUrl: model.baseUrl, model: model.id,
      secretRef: 'test-secret', toolCalls: true,
    });
    expect(repositories.globalGenerationConfig.update(0, { providerId: provider.id }).ok).toBe(true);

    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/generations`,
      payload: { conversationRevision: conversation.revision, mode: 'normal', userText: '守住档案馆。' },
    });
    expect(terminal(response.payload)).toEqual({ event: 'completed', data: { finishReason: 'stop' } });
    expect(response.payload).toContain('"kind":"scene-action","label":"Performing a Scene action"');
    expect(response.payload).not.toContain('SECRET-TOOL-ARGUMENT');
    expect(contexts[0]!.tools?.map((tool) => tool.name)).toEqual([
      'save_state_read', 'world_query', 'deterministic_check', 'scene_patch_stage',
      'destined_poem_adjust_fate', 'destined_poem_adjust_vitals', 'destined_poem_travel',
      'destined_poem_update_relationship', 'destined_poem_update_quest', 'destined_poem_rule_check',
      'scene_view_stage',
    ]);
    const toolResult = contexts[1]!.messages.find((message) => (
      message.role === 'toolResult' && message.toolName === 'destined_poem_adjust_fate'
    ));
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      isError: false,
      details: {
        scene: { before: 0, after: 3, amount: 3, reason: 'SECRET-TOOL-ARGUMENT' },
        patch: {
          appliedCount: 1,
          applied: [{ op: 'delta', path: '/命运点数' }],
          failureCount: 0,
          failures: [],
          stagedOperationCount: 1,
        },
      },
    });
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)?.value.命运点数).toBe(3);
    expect(repositories.sceneStateTransitions.listByConversationId(conversation.id)).toEqual([
      expect.objectContaining({
        sourceKind: 'message-variant',
        operations: [{ op: 'delta', path: '/命运点数', value: 3 }],
      }),
    ]);

    const coverageScene = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    const coverageHost = new SceneModuleHost(pathToFileURL(join(coverageScene.installPath, 'server/index.mjs')).href);
    try {
      const coverageWorkspace = new TurnWorkspace({
        generationId: randomUUID(),
        payload: { seed: 'official-coverage', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
        state: {
          revision: repositories.conversationSceneStates.getByConversationId(conversation.id)!.revision,
          value: repositories.conversationSceneStates.getByConversationId(conversation.id)!.value,
          manifest: coverageScene.manifest,
        },
      });
      const coverageTools = createSceneAgentToolFactory({
        scene: coverageScene,
        host: coverageHost,
        conversation: repositories.conversations.get(conversation.id)!,
      })!(coverageWorkspace);
      const execute = async (name: string, args: Record<string, unknown>) => {
        const tool = coverageTools.find((candidate) => candidate.name === name)!;
        return tool.execute(`${name}-call`, args, new AbortController().signal);
      };
      await execute('destined_poem_adjust_vitals', { hpDelta: -2, addStatus: '警觉' });
      await execute('destined_poem_travel', { location: '奥古斯提姆帝国', time: '黄昏' });
      await execute('destined_poem_update_relationship', {
        entityId: 'lyra', name: '莉拉', affinityDelta: 8, description: '并肩守卫档案馆。',
      });
      await execute('destined_poem_update_quest', {
        questId: 'guard_archive', title: '守住档案馆', status: 'completed', description: '噬页兽已经退去。',
      });
      const check = await execute('destined_poem_rule_check', {
        key: 'archive-vault', difficulty: 10, modifier: 2, sides: 20,
      });
      expect(check.details).toMatchObject({
        scene: expect.objectContaining({ key: 'archive-vault', roll: expect.any(Number), success: expect.any(Boolean) }),
        patch: { appliedCount: 0, failureCount: 0 },
      });
      const staged = coverageWorkspace.snapshot();
      expect(staged.stagedValue).toMatchObject({
        世界: { 地点: '奥古斯提姆帝国', 时间: '黄昏' },
        主角: { 状态效果: { 警觉: true } },
        关系列表: { lyra: { 姓名: '莉拉', 好感度: 8 } },
        任务列表: { guard_archive: { 标题: '守住档案馆', 状态: 'completed' } },
      });
      const viewRuntimeFactory = createSceneViewRuntimeFactory({
        scene: coverageScene,
        host: coverageHost,
        conversation: repositories.conversations.get(conversation.id)!,
      })!;
      const coverageViews = viewRuntimeFactory(coverageWorkspace);
      const references: string[] = [];
      for (const kind of ['status', 'map', 'relationship', 'progress'] as const) {
        const result = await coverageViews.tool().execute(
          `view-${kind}`,
          { kind, relatedEntities: kind === 'relationship' ? ['lyra'] : [], insertionIntent: 'inline' },
          new AbortController().signal,
        );
        references.push((result.details as { reference: string }).reference);
      }
      const resolvedCoverage = await coverageViews.resolve(
        `战后记录。${references.join('随后，')}旅程继续。`,
        new AbortController().signal,
      );
      expect(resolvedCoverage.diagnostics).toEqual([]);
      expect(resolvedCoverage.document.blocks.filter((block) => block.type === 'scene-view').map((block) => ({
        kind: block.kind, props: block.props,
      }))).toEqual([
        expect.objectContaining({ kind: 'status', props: expect.objectContaining({ name: expect.any(String) }) }),
        expect.objectContaining({ kind: 'map', props: expect.objectContaining({ location: '奥古斯提姆帝国' }) }),
        expect.objectContaining({ kind: 'relationship', props: { entries: [expect.objectContaining({ id: 'lyra', affinity: 8 })] } }),
        expect.objectContaining({ kind: 'progress', props: expect.objectContaining({
          quests: [expect.objectContaining({ id: 'guard_archive', status: 'completed' })],
        }) }),
      ]);

      const securityWorkspace = new TurnWorkspace({
        generationId: randomUUID(),
        payload: { seed: 'official-dangerous-segments', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
        state: { revision: 10, value: staged.stagedValue, manifest: coverageScene.manifest },
      });
      const securityTools = createSceneAgentToolFactory({
        scene: coverageScene, host: coverageHost, conversation: repositories.conversations.get(conversation.id)!,
      })!(securityWorkspace);
      const securityExecute = async (name: string, args: Record<string, unknown>) => securityTools
        .find((candidate) => candidate.name === name)!
        .execute(`${name}-dangerous`, args, new AbortController().signal);
      await securityExecute('destined_poem_adjust_vitals', { addStatus: '__proto__' });
      await securityExecute('destined_poem_update_relationship', {
        entityId: 'constructor', name: 'Own constructor', affinityDelta: 1, description: 'Persisted data key.',
      });
      await securityExecute('destined_poem_update_quest', {
        questId: 'prototype', title: 'Own prototype', status: 'active', description: 'Persisted data key.',
      });
      const secured = securityWorkspace.snapshot().stagedValue;
      expect(Object.hasOwn((secured.主角 as Record<string, any>).状态效果, '__proto__')).toBe(true);
      expect(Object.hasOwn(secured.关系列表 as object, 'constructor')).toBe(true);
      expect(Object.hasOwn(secured.任务列表 as object, 'prototype')).toBe(true);
      const clonedSecured = structuredClone(JSON.parse(JSON.stringify(secured)));
      expect(Object.hasOwn(clonedSecured.主角.状态效果, '__proto__')).toBe(true);
      expect(Object.hasOwn(clonedSecured.关系列表, 'constructor')).toBe(true);
      expect(Object.hasOwn(clonedSecured.任务列表, 'prototype')).toBe(true);

      const oversizedState = structuredClone(staged.stagedValue) as Record<string, any>;
      oversizedState.主角.状态效果 = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
        `status-${String(index).padStart(3, '0')}-${'s'.repeat(200)}`, true,
      ]));
      oversizedState.主角.属性 = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
        `attribute-${String(index).padStart(3, '0')}-${'a'.repeat(200)}`, index,
      ]));
      oversizedState.关系列表 = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
        `relation-${String(index).padStart(3, '0')}`,
        { 姓名: `Name ${'n'.repeat(500)}`, 好感度: index, 描述: 'r'.repeat(10_000) },
      ]));
      oversizedState.任务列表 = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
        `quest-${String(index).padStart(3, '0')}`,
        { 标题: `Quest ${'q'.repeat(500)}`, 状态: 'active', 描述: 'd'.repeat(10_000) },
      ]));
      const boundedWorkspace = new TurnWorkspace({
        generationId: randomUUID(),
        payload: { seed: 'official-bounded-views', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
        state: { revision: 11, value: oversizedState, manifest: coverageScene.manifest },
      });
      const boundedViews = viewRuntimeFactory(boundedWorkspace);
      const boundedReferences: string[] = [];
      for (const kind of ['status', 'relationship', 'progress'] as const) {
        const result = await boundedViews.tool().execute(
          `bounded-${kind}`, { kind, relatedEntities: [], insertionIntent: 'inline' },
          new AbortController().signal,
        );
        boundedReferences.push((result.details as { reference: string }).reference);
      }
      const boundedDocument = await boundedViews.resolve(boundedReferences.join(''), new AbortController().signal);
      expect(boundedDocument.diagnostics).toEqual([]);
      const boundedBlocks = boundedDocument.document.blocks.filter((block) => block.type === 'scene-view');
      const statusProps = boundedBlocks.find((block) => block.kind === 'status')!.props as Record<string, any>;
      const relationshipProps = boundedBlocks.find((block) => block.kind === 'relationship')!.props as Record<string, any>;
      const progressProps = boundedBlocks.find((block) => block.kind === 'progress')!.props as Record<string, any>;
      expect(statusProps.statuses).toHaveLength(32);
      expect(Object.keys(statusProps.attributes)).toHaveLength(32);
      expect(relationshipProps.entries).toHaveLength(32);
      expect(relationshipProps.entries[0].description.length).toBeLessThanOrEqual(500);
      expect(progressProps.quests).toHaveLength(32);
      expect(progressProps.quests[0].description.length).toBeLessThanOrEqual(1_000);
    } finally {
      await coverageHost.close();
    }

    const currentState = repositories.conversationSceneStates.getByConversationId(conversation.id)!;
    const objectiveState = structuredClone(currentState.value);
    const protagonist = objectiveState.主角 as Record<string, unknown>;
    protagonist.姓名 = '艾琳';
    protagonist.生命值 = 18;
    protagonist.生命值上限 = 24;
    protagonist.状态效果 = { 专注: true };
    objectiveState.事件 = { ...(objectiveState.事件 as Record<string, unknown>), 标题: '档案馆防卫战' };
    objectiveState.关系列表 = {
      archive_guard: {
        姓名: '噬页兽', 生命值: 9, 生命值上限: 15, 状态效果: { 灼烧: true },
      },
    };
    expect(repositories.conversationSceneStates.update(currentState.id, currentState.revision, {
      value: objectiveState,
    }).ok).toBe(true);
    const viewContexts: Context[] = [];
    runtimeFactory = () => viewRuntime(viewContexts);
    const currentConversation = repositories.conversations.get(conversation.id)!;
    const viewResponse = await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/generations`,
      payload: { conversationRevision: currentConversation.revision, mode: 'normal', userText: '展示当前战况。' },
    });
    expect(terminal(viewResponse.payload)).toEqual({ event: 'completed', data: { finishReason: 'stop' } });
    expect(viewResponse.payload).toContain('event: activity');
    expect(viewResponse.payload).toContain('"kind":"stage-view","label":"Preparing a Scene view"');
    expect(viewResponse.payload).toContain('event: view_placeholder');
    expect(viewResponse.payload.match(/event: view_placeholder/g)).toHaveLength(1);
    expect(viewResponse.payload).not.toContain('<!--tavernnext:view:');
    expect(viewResponse.payload.indexOf('"text":"战斗爆发。"')).toBeLessThan(
      viewResponse.payload.indexOf('event: view_placeholder'),
    );
    expect(viewResponse.payload.indexOf('event: view_placeholder')).toBeLessThan(
      viewResponse.payload.indexOf('"text":"局势仍在变化。"'),
    );
    expect(viewContexts[0]!.tools?.map((tool) => tool.name)).toContain('scene_view_stage');
    const viewVariant = repositories.messageVariants.listByConversationId(conversation.id).at(-1)!;
    expect(viewVariant.content).toBe('战斗爆发。局势仍在变化。');
    expect(viewVariant.document.blocks).toEqual([
      { type: 'markdown', content: '战斗爆发。' },
      expect.objectContaining({
        type: 'scene-view',
        kind: 'combat',
        schemaVersion: 1,
        rendererId: 'destined-poem-combat-v1',
        sourceStateRevision: 3,
        props: {
          title: '档案馆防卫战',
          location: '梵尼亚',
          protagonist: { name: '艾琳', hp: 18, maxHp: 24, statuses: ['专注'] },
          opponents: [{
            id: 'archive_guard', name: '噬页兽', hp: 9, maxHp: 15, statuses: ['灼烧'],
          }],
        },
      }),
      { type: 'markdown', content: '局势仍在变化。' },
    ]);
    expect(repositories.agentRuns.listByConversationId(conversation.id).map((run) => run.activities)).toEqual([
      [expect.objectContaining({
        kind: 'scene-action', label: 'Performing a Scene action', status: 'completed',
      })],
      [expect.objectContaining({
        kind: 'stage-view', label: 'Preparing a Scene view', status: 'completed',
      })],
    ]);
    expect(JSON.stringify(repositories.agentRuns.listByConversationId(conversation.id)))
      .not.toContain('SECRET-TOOL-ARGUMENT');
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)?.revision).toBe(3);
    const reloaded = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/messages` });
    expect(reloaded.json().messages.at(-1).variants[0].document).toEqual(viewVariant.document);
    const beforeContinue = structuredClone(viewVariant.document);
    const continueResponse = await app.inject({
      method: 'POST', url: `/api/conversations/${conversation.id}/generations`,
      payload: {
        conversationRevision: repositories.conversations.get(conversation.id)!.revision,
        mode: 'continue',
        messageIndex: repositories.messages.listByConversationId(conversation.id).length,
      },
    });
    expect(continueResponse.statusCode).toBe(200);
    expect(terminal(continueResponse.payload)).toEqual({ event: 'completed', data: { finishReason: 'stop' } });
    const continued = repositories.messageVariants.get(viewVariant.id)!;
    expect(continued.content).toBe(`${viewVariant.content} 战斗余波。`);
    expect(continued.document.blocks.slice(0, -1)).toEqual(beforeContinue.blocks.slice(0, -1));
    expect(continued.document.blocks.at(-1)).toEqual({
      type: 'markdown', content: '局势仍在变化。 战斗余波。',
    });

    const official = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    const firstPackage = buildDestinedPoemPackage();
    const originalFirstByte = firstPackage.bytes[0];
    firstPackage.manifest.name = 'poisoned';
    firstPackage.manifest.agentTools.splice(0);
    firstPackage.bytes[0] = originalFirstByte === 0 ? 1 : 0;
    const secondPackage = buildDestinedPoemPackage();
    expect(secondPackage.manifest.name).toBe('命定之诗与黄昏之歌');
    expect(secondPackage.manifest.agentTools).toHaveLength(6);
    expect(secondPackage.bytes[0]).toBe(originalFirstByte);
    expect(secondPackage.digest).toBe(official.archiveDigest);
    expect(isBundledOfficialScene(official)).toBe(true);
    expect(createSceneAgentToolFactory({
      scene: { ...official, id: randomUUID() },
      host: { call: async () => ({}) } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    })).toBeUndefined();
    expect(() => createSceneAgentToolFactory({
      scene: {
        ...official,
        manifest: {
          ...official.manifest,
          agentTools: [{
            name: 'scene_view_stage',
            description: 'Must remain reserved for the platform.',
            parameters: { type: 'object' },
          }],
        },
      },
      host: { call: async () => ({}) } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    })).toThrow('scene_agent_tool_name_reserved');

    const partialWorkspace = new TurnWorkspace({
      generationId: randomUUID(),
      payload: { seed: 'scene-tool-partial', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
      state: { revision: 4, value: { 命运点数: 0 }, manifest: official.manifest },
    });
    const partialFactory = createSceneAgentToolFactory({
      scene: official,
      host: {
        call: async () => ({
          content: 'partial',
          detail: { source: 'test' },
          statePatch: [
            { op: 'delta', path: '/命运点数', value: 2 },
            { op: 'delta', path: '/不存在', value: 1 },
          ],
        }),
      } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    });
    const partialResult = await partialFactory!(partialWorkspace)[0]!.execute(
      'partial-1',
      { amount: 2, reason: 'test' },
      new AbortController().signal,
    );
    expect(partialResult.details).toMatchObject({
      scene: { source: 'test' },
      patch: {
        appliedCount: 1,
        applied: [{ op: 'delta', path: '/命运点数' }],
        failureCount: 1,
        failures: [{ operationIndex: 1, code: 'scene_patch_invalid' }],
      },
    });
    expect(partialWorkspace.snapshot()).toMatchObject({
      stagedValue: { 命运点数: 2 },
      operations: [{ op: 'delta', path: '/命运点数', value: 2 }],
      failures: [{ operationIndex: 1, code: 'scene_patch_invalid' }],
    });

    const oversizedWorkspace = new TurnWorkspace({
      generationId: randomUUID(),
      payload: { seed: 'scene-tool-oversized', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
      state: { revision: 5, value: { 命运点数: 0 }, manifest: official.manifest },
    });
    const oversizedFactory = createSceneAgentToolFactory({
      scene: official,
      host: {
        call: async () => ({
          detail: { oversized: 'x'.repeat(70 * 1024) },
          statePatch: [{ op: 'delta', path: '/命运点数', value: 9 }],
        }),
      } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    });
    await expect(oversizedFactory!(oversizedWorkspace)[0]!.execute(
      'oversized-1',
      { amount: 9, reason: 'test' },
      new AbortController().signal,
    )).rejects.toThrow('scene_agent_tool_result_too_large');
    expect(oversizedWorkspace.snapshot()).toMatchObject({ stagedValue: { 命运点数: 0 }, operations: [] });

    const nonJsonWorkspace = new TurnWorkspace({
      generationId: randomUUID(),
      payload: { seed: 'scene-tool-map', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
      state: { revision: 6, value: { 命运点数: 0 }, manifest: official.manifest },
    });
    const nonJsonFactory = createSceneAgentToolFactory({
      scene: official,
      host: {
        call: async () => ({
          detail: new Map([['hidden', 'x'.repeat(70 * 1024)]]),
          statePatch: [{ op: 'delta', path: '/命运点数', value: 7 }],
        }),
      } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    });
    await expect(nonJsonFactory!(nonJsonWorkspace)[0]!.execute(
      'map-1', { amount: 7, reason: 'test' }, new AbortController().signal,
    )).rejects.toThrow('scene_agent_tool_result_invalid');
    expect(nonJsonWorkspace.snapshot()).toMatchObject({ stagedValue: { 命运点数: 0 }, operations: [] });
    const setWorkspace = new TurnWorkspace({
      generationId: randomUUID(),
      payload: { seed: 'scene-tool-set', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
      state: { revision: 6, value: { 命运点数: 0 }, manifest: official.manifest },
    });
    const setFactory = createSceneAgentToolFactory({
      scene: official,
      host: {
        call: async () => ({
          detail: new Set(['x'.repeat(70 * 1024)]),
          statePatch: [{ op: 'delta', path: '/命运点数', value: 7 }],
        }),
      } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    });
    await expect(setFactory!(setWorkspace)[0]!.execute(
      'set-1', { amount: 7, reason: 'test' }, new AbortController().signal,
    )).rejects.toThrow('scene_agent_tool_result_invalid');
    expect(setWorkspace.snapshot()).toMatchObject({ stagedValue: { 命运点数: 0 }, operations: [] });

    const nearLimitRaw = {
      content: 'c'.repeat(32_000),
      detail: { padding: 'd'.repeat(30_000) },
      statePatch: Array.from({ length: 32 }, () => ({})),
    };
    expect(Buffer.byteLength(JSON.stringify(nearLimitRaw))).toBeLessThan(64 * 1024);
    const nearLimitWorkspace = new TurnWorkspace({
      generationId: randomUUID(),
      payload: { seed: 'scene-tool-final-limit', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
      state: { revision: 7, value: { 命运点数: 0 }, manifest: official.manifest },
    });
    const nearLimitFactory = createSceneAgentToolFactory({
      scene: official,
      host: { call: async () => nearLimitRaw } as unknown as SceneModuleHost,
      conversation: repositories.conversations.get(conversation.id)!,
    });
    await expect(nearLimitFactory!(nearLimitWorkspace)[0]!.execute(
      'near-limit-1', { amount: 1, reason: 'test' }, new AbortController().signal,
    )).rejects.toThrow('scene_agent_tool_result_too_large');
    expect(nearLimitWorkspace.snapshot()).toMatchObject({ stagedValue: { 命运点数: 0 }, operations: [] });
  }, 60_000);
});
