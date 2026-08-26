import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { SceneModuleHost } from '../src/scenes/scene-module-host.js';
import { createSceneAgentToolFactory } from '../src/services/scene-agent-tools.js';
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
            arguments: { amount: 3, reason: '守住档案馆' },
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
        events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
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
    expect(installed.json().manifest.agentTools).toEqual([
      expect.objectContaining({
        name: 'destined_poem_adjust_fate', parameters: expect.objectContaining({ type: 'object' }),
      }),
    ]);
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
    expect(contexts[0]!.tools?.map((tool) => tool.name)).toEqual([
      'save_state_read', 'world_query', 'deterministic_check', 'scene_patch_stage',
      'destined_poem_adjust_fate', 'scene_view_stage',
    ]);
    const toolResult = contexts[1]!.messages.find((message) => (
      message.role === 'toolResult' && message.toolName === 'destined_poem_adjust_fate'
    ));
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      isError: false,
      details: {
        scene: { before: 0, after: 3, amount: 3, reason: '守住档案馆' },
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
        sourceStateRevision: 2,
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
    expect(secondPackage.manifest.agentTools).toHaveLength(1);
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
