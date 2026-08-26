import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import type { PiAgentModelRuntime } from '@tavernnext/provider-openai-compatible';
import { TokenizerId } from '@tavernnext/tokenizer-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';
import { unitTokenizerRuntime } from './prompt-integration-fixtures.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const usage = (): Usage => ({
  input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const model: Model<'openai-completions'> = {
  id: 'workspace-model', name: 'Workspace Model', api: 'openai-completions', provider: 'custom-openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_096,
};

const calls: ToolCall[] = [
  {
    type: 'toolCall', id: 'patch-1', name: 'scene_patch_stage', arguments: { operations: [
      { op: 'delta', path: '/points', value: 3 },
      { op: 'delta', path: '/missing', value: 1 },
    ] },
  },
  { type: 'toolCall', id: 'read-1', name: 'save_state_read', arguments: { paths: ['/points'] } },
  { type: 'toolCall', id: 'world-1', name: 'world_query', arguments: { query: 'archive dusk', limit: 3 } },
  {
    type: 'toolCall', id: 'check-1', name: 'deterministic_check',
    arguments: { key: 'vault-door', difficulty: 10, modifier: 2, sides: 20 },
  },
];

function toolTurn(toolCalls: readonly ToolCall[]): ReturnType<typeof createAssistantMessageEventStream> {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: usage(), stopReason: 'pending', timestamp: Date.now(),
    };
    events.push({ type: 'start', partial });
    for (const toolCall of toolCalls) {
      partial.content.push(toolCall);
      events.push({ type: 'toolcall_end', contentIndex: partial.content.length - 1, toolCall, partial });
    }
    const message: AssistantMessage = { ...partial, content: structuredClone([...toolCalls]), stopReason: 'toolUse' };
    events.push({ type: 'done', reason: 'toolUse', message });
    events.end(message);
  });
  return events;
}

function textTurn(text: string, failure = false): ReturnType<typeof createAssistantMessageEventStream> {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api,
      provider: model.provider, model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now(),
    };
    events.push({ type: 'start', partial });
    if (text !== '') events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
    if (failure) {
      const error: AssistantMessage = {
        ...partial, content: [{ type: 'text', text }], stopReason: 'error', errorMessage: 'injected failure',
      };
      events.push({ type: 'error', reason: 'error', error });
      events.end(error);
      return;
    }
    const message: AssistantMessage = {
      ...partial, content: [{ type: 'text', text }], stopReason: 'stop',
    };
    events.push({ type: 'done', reason: 'stop', message });
    events.end(message);
  });
  return events;
}

function scriptedRuntime(options: {
  contexts: Context[];
  finalText?: string;
  fail?: boolean;
  beforeFinal?: () => void;
  toolCalls?: readonly ToolCall[];
}): PiAgentModelRuntime {
  let turn = 0;
  return {
    model,
    stream(_model, context) {
      options.contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
        ...(context.tools === undefined ? {} : {
          tools: context.tools.map((tool) => ({
            name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
          })),
        }),
      });
      if (turn++ === 0) return toolTurn(options.toolCalls ?? calls);
      options.beforeFinal?.();
      return textTurn(options.finalText ?? 'The archive gate opens.', options.fail);
    },
  };
}

async function context(runtimeFactory: () => PiAgentModelRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-workspace-run-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    tokenizerRuntime: unitTokenizerRuntime(),
    piAgentRuntimeFactory: runtimeFactory,
  });
  apps.push(app);
  await app.ready();

  const character = repositories.characters.create({
    id: randomUUID(), name: 'Aster', description: 'An archive keeper.', personality: '', scenario: '',
    firstMessage: '', alternateGreetings: [], tags: [],
  });
  const persona = repositories.personas.create({
    id: randomUUID(), name: 'Traveler', description: 'A visitor.', isDefault: true,
  });
  const preset = repositories.presets.create({
    id: randomUUID(), name: 'Workspace style', kind: 'chat', settings: {
      tokenizer: TokenizerId.NONE,
      prompts: [{ identifier: 'style', role: 'system', content: 'Write concise fantasy prose.' }],
      prompt_order: [{ character_id: character.id, order: [{ identifier: 'style', enabled: true }] }],
    },
  });
  const sceneId = randomUUID();
  repositories.installedScenes.create({
    id: sceneId,
    slug: 'workspace-test',
    version: '1.0.0',
    archiveDigest: 'a'.repeat(64),
    installPath: directory,
    installedAt: new Date().toISOString(),
    manifest: {
      id: sceneId,
      slug: 'workspace-test',
      version: '1.0.0',
      name: 'Workspace Test',
      summary: '',
      description: '',
      author: 'TavernNext',
      minimumTavernNextVersion: '0.1.0',
      sceneSdkVersion: 2,
      frontendEntry: 'frontend.js',
      frontendStyles: [],
      setupSchema: {},
      stateSchema: {},
      agentTools: [],
      files: ['frontend.js'],
    },
    backingCharacterId: character.id,
    backingPresetId: preset.id,
  });
  const worldbook = repositories.worldbooks.create({
    id: randomUUID(), name: 'Archive Lore', description: '', enabled: true, isGlobal: false,
  });
  const worldEntry = repositories.worldbookEntries.create({
    id: randomUUID(), worldbookId: worldbook.id, keys: ['archive', 'dusk'],
    content: 'The archive vault opens only at dusk.', enabled: true, constant: false, position: 0, order: 0,
  });
  const conversation = repositories.conversations.create({
    id: randomUUID(), characterId: character.id, personaId: persona.id, sceneId,
    title: 'Workspace Save', worldbookIds: [worldbook.id],
  });
  repositories.saveAgentConfigurations.create({
    id: randomUUID(), conversationId: conversation.id, sourcePresetId: preset.id,
    sourcePresetRevision: preset.revision, name: preset.name, settings: preset.settings,
  });
  const sceneState = repositories.conversationSceneStates.create({
    id: randomUUID(), conversationId: conversation.id, schemaVersion: 1,
    baseValue: { points: 2, map: { place: 'gate' } }, headTransitionId: null,
    value: { points: 2, map: { place: 'gate' } },
  });
  const provider = repositories.providerProfiles.create({
    id: randomUUID(), name: 'Agent Provider', baseUrl: model.baseUrl, model: model.id,
    secretRef: 'test-secret', toolCalls: true,
  });
  expect(repositories.globalGenerationConfig.update(0, {
    providerId: provider.id, chatPresetId: preset.id,
  }).ok).toBe(true);
  return { app, database, repositories, conversation, sceneState, worldEntry };
}

async function generate(app: ReturnType<typeof createApp>, conversationId: string, revision = 0) {
  return app.inject({
    method: 'POST', url: `/api/conversations/${conversationId}/generations`,
    payload: { conversationRevision: revision, mode: 'normal', userText: 'Open the vault.' },
  });
}

function terminal(payload: string) {
  const frames = payload.trim().split(/\r?\n\r?\n/).filter(Boolean);
  const lines = frames.at(-1)!.split(/\r?\n/);
  return {
    event: lines.find((line) => line.startsWith('event: '))?.slice(7),
    data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>,
  };
}

function toolDetails(context: Context, name: string): Record<string, unknown> {
  const message = context.messages.find((candidate) => candidate.role === 'toolResult' && candidate.toolName === name);
  if (message?.role !== 'toolResult') throw new Error(`missing result ${name}`);
  return message.details as Record<string, unknown>;
}

describe('Scene Director Turn Workspace integration', () => {
  it('runs only platform tools, exposes ordered staged changes, and commits valid operations atomically', async () => {
    const contexts: Context[] = [];
    const seeded = await context(() => scriptedRuntime({ contexts }));
    const response = await generate(seeded.app, seeded.conversation.id);
    expect(terminal(response.payload)).toEqual({ event: 'completed', data: { finishReason: 'stop' } });

    expect(contexts[0]!.tools?.map((tool) => tool.name)).toEqual([
      'save_state_read', 'world_query', 'deterministic_check', 'scene_patch_stage',
    ]);
    expect(toolDetails(contexts[1]!, 'scene_patch_stage')).toMatchObject({
      ok: false,
      appliedCount: 1,
      applied: [{ op: 'delta', path: '/points' }],
      failureCount: 1,
      failures: [{ operationIndex: 1, code: 'scene_patch_invalid' }],
      stagedOperationCount: 1,
    });
    expect(toolDetails(contexts[1]!, 'save_state_read')).toMatchObject({
      ok: true, stateRevision: seeded.sceneState.revision,
      values: [{ path: '/points', ok: true, value: 5 }],
    });
    expect(toolDetails(contexts[1]!, 'world_query')).toMatchObject({
      ok: true,
      results: [expect.objectContaining({
        entryKey: seeded.worldEntry.id,
        content: 'The archive vault opens only at dusk.',
      })],
    });
    expect(toolDetails(contexts[1]!, 'deterministic_check')).toMatchObject({
      ok: true, key: 'vault-door', sides: 20, difficulty: 10, modifier: 2,
    });

    const state = seeded.repositories.conversationSceneStates.getByConversationId(seeded.conversation.id)!;
    expect(state).toMatchObject({ revision: 1, value: { points: 5, map: { place: 'gate' } } });
    const transitions = seeded.repositories.sceneStateTransitions.listByConversationId(seeded.conversation.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      sourceKind: 'message-variant',
      operations: [{ op: 'delta', path: '/points', value: 3 }],
      value: { points: 5, map: { place: 'gate' } },
    });
    expect(seeded.repositories.messageVariants.listByConversationId(seeded.conversation.id)).toEqual([
      expect.objectContaining({ status: 'completed', content: 'The archive gate opens.' }),
    ]);
    expect(seeded.repositories.agentRuns.listByConversationId(seeded.conversation.id)).toEqual([
      expect.objectContaining({ status: 'completed', counts: { modelTurns: 2, toolCalls: 4 } }),
    ]);
    expect(seeded.repositories.generationSnapshots.list()).toHaveLength(1);
    expect((seeded.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM consumed_generation_snapshots',
    ).get() as { count: number }).count).toBe(1);
  });

  it('discards staged operations on provider failure and on Scene State revision conflict', async () => {
    const failureContexts: Context[] = [];
    let runtime = scriptedRuntime({ contexts: failureContexts, finalText: 'unsafe partial', fail: true });
    const seeded = await context(() => runtime);
    expect(terminal((await generate(seeded.app, seeded.conversation.id)).payload)).toEqual({
      event: 'failed', data: { code: 'connection' },
    });
    expect(seeded.repositories.conversationSceneStates.getByConversationId(seeded.conversation.id)).toEqual(
      seeded.sceneState,
    );
    expect(seeded.repositories.messageVariants.listByConversationId(seeded.conversation.id)).toEqual([]);
    expect(seeded.repositories.generationSnapshots.list()).toEqual([]);
    expect((seeded.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM consumed_generation_snapshots',
    ).get() as { count: number }).count).toBe(0);

    const currentConversation = seeded.repositories.conversations.get(seeded.conversation.id)!;
    runtime = scriptedRuntime({
      contexts: [],
      toolCalls: [calls[1]!],
      beforeFinal() {
        const current = seeded.repositories.conversationSceneStates.getByConversationId(seeded.conversation.id)!;
        const updated = seeded.repositories.conversationSceneStates.update(current.id, current.revision, {
          value: { ...current.value, external: true },
        });
        if (!updated.ok) throw new Error(updated.reason);
      },
    });
    expect(terminal((await generate(seeded.app, seeded.conversation.id, currentConversation.revision)).payload)).toEqual({
      event: 'failed', data: { code: 'conflict' },
    });
    expect(seeded.repositories.conversationSceneStates.getByConversationId(seeded.conversation.id)).toMatchObject({
      revision: 1,
      value: { points: 2, map: { place: 'gate' }, external: true },
    });
    expect(seeded.repositories.messageVariants.listByConversationId(seeded.conversation.id)).toEqual([]);
    expect(seeded.repositories.generationSnapshots.list()).toEqual([]);
    expect((seeded.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM consumed_generation_snapshots',
    ).get() as { count: number }).count).toBe(0);
    expect(seeded.repositories.agentRuns.listByConversationId(seeded.conversation.id).map((run) => run.status))
      .toEqual(['failed', 'failed']);
    expect(seeded.repositories.agentRuns.listByConversationId(seeded.conversation.id)[1]).toMatchObject({
      counts: { modelTurns: 2, toolCalls: 1 },
      failureCode: 'conflict',
    });
    expect(seeded.repositories.sceneStateTransitions.listByConversationId(seeded.conversation.id)).toEqual([]);
  });
});
