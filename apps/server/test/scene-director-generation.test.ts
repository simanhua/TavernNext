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
import { TokenizerId } from '@tavernnext/tokenizer-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { createGenerationService } from '../src/services/generation-service.js';
import { SceneDirectorExecution } from '../src/services/scene-director-agent.js';
import type { SaveAgentRuntimeEvent } from '../src/services/save-agent-runtime.js';
import {
  createPromptSnapshotService,
  type PromptSnapshotPayload,
  type PromptSnapshotService,
  type ServerTokenizerRuntime,
} from '../src/services/prompt-snapshot-service.js';
import { unitTokenizerRuntime } from './prompt-integration-fixtures.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const ids = {
  character: '018f0000-0000-7000-8000-000000000201',
  persona: '018f0000-0000-7000-8000-000000000202',
  provider: '018f0000-0000-7000-8000-000000000203',
  conversation: '018f0000-0000-7000-8000-000000000204',
  preset: '018f0000-0000-7000-8000-000000000205',
  configuration: '018f0000-0000-7000-8000-000000000206',
};

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

const oneTokenRuntime: ServerTokenizerRuntime = {
  selectTokenizer: () => { throw new Error('unused'); },
  countText: async () => 1,
  countMessages: async () => 1,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const usage = (input = 4, output = 2): Usage => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const model: Model<'openai-completions'> = {
  id: 'mock-agent', name: 'Mock Agent', api: 'openai-completions', provider: 'test',
  baseUrl: 'http://127.0.0.1:8080/v1', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_096,
};

function completedRuntime(
  outputs: string[],
  contexts: Context[] = [],
  requests: Array<{ options: Record<string, unknown>; payload: unknown }> = [],
  runtimeModel: PiAgentModelRuntime['model'] = model,
): PiAgentModelRuntime {
  return {
    model: runtimeModel,
    stream(_model, context, options) {
      contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
        ...(context.tools === undefined ? {} : {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: structuredClone(tool.parameters),
          })),
        }),
      });
      const text = outputs.shift() ?? '';
      const events = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        requests.push({
          options: {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            reasoning: options?.reasoning,
            samplingParams: options?.samplingParams,
          },
          payload: await options?.onPayload?.({ model: runtimeModel.id, messages: [] }, runtimeModel),
        });
        const partial: AssistantMessage = {
          role: 'assistant', content: [], api: runtimeModel.api, provider: runtimeModel.provider, model: runtimeModel.id,
          usage: usage(), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        partial.content.push({ type: 'thinking', thinking: '' });
        events.push({ type: 'thinking_start', contentIndex: 0, partial });
        events.push({ type: 'thinking_delta', contentIndex: 0, delta: 'PRIVATE-CHAIN-OF-THOUGHT', partial });
        partial.content.push({ type: 'text', text: '' });
        events.push({ type: 'text_start', contentIndex: 1, partial });
        if (text !== '') events.push({ type: 'text_delta', contentIndex: 1, delta: text, partial });
        const message: AssistantMessage = {
          ...partial,
          content: [{ type: 'thinking', thinking: 'PRIVATE-CHAIN-OF-THOUGHT' }, { type: 'text', text }],
          usage: usage(), stopReason: 'stop',
        };
        events.push({ type: 'done', reason: 'stop', message });
        events.end(message);
      });
      return events;
    },
  };
}

function oneToolRuntime(
  contexts: Context[],
  toolName: string,
  args: Record<string, unknown>,
  text: string,
): PiAgentModelRuntime {
  let turn = 0;
  return {
    model,
    stream(_model, context) {
      contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
        ...(context.tools === undefined ? {} : { tools: context.tools.map((tool) => ({
          name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
        })) }),
      });
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (turn++ === 0) {
          const toolCall = { type: 'toolCall' as const, id: 'tier-query', name: toolName, arguments: args };
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
        const partial: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider,
          model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now(),
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

function failedRuntime(text: string, secret: string): PiAgentModelRuntime {
  return {
    model,
    stream() {
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api,
          provider: model.provider, model: model.id, usage: usage(1, 1), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        if (text !== '') events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
        const failure: AssistantMessage = {
          ...partial, content: [{ type: 'text', text }], stopReason: 'error',
          errorMessage: `provider failed with ${secret}`,
        };
        events.push({ type: 'error', reason: 'error', error: failure });
        events.end(failure);
      });
      return events;
    },
  };
}

function loopingRuntime(counter: { calls: number }): PiAgentModelRuntime {
  return {
    model,
    stream() {
      counter.calls += 1;
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const toolCall = { type: 'toolCall' as const, id: `missing-${counter.calls}`, name: 'missing', arguments: {} };
        const partial: AssistantMessage = {
          role: 'assistant', content: [toolCall], api: model.api, provider: model.provider, model: model.id,
          usage: usage(1, 1), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial });
        const message: AssistantMessage = { ...partial, stopReason: 'toolUse' };
        events.push({ type: 'done', reason: 'toolUse', message });
        events.end(message);
      });
      return events;
    },
  };
}

function cancellableRuntime(entered: { resolve(value: void): void }): PiAgentModelRuntime {
  return {
    model,
    stream(_model, _context, options) {
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api,
          provider: model.provider, model: model.id, usage: usage(1, 1), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: 'Agent partial', partial });
        entered.resolve(undefined);
        const finish = () => {
          const failure: AssistantMessage = {
            ...partial, content: [{ type: 'text', text: 'Agent partial' }], stopReason: 'aborted', errorMessage: 'aborted',
          };
          events.push({ type: 'error', reason: 'aborted', error: failure });
          events.end(failure);
        };
        options?.signal?.addEventListener('abort', finish, { once: true });
      });
      return events;
    },
  };
}

function hangingRuntime(release: Promise<void>): PiAgentModelRuntime {
  return {
    model,
    stream() {
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: usage(0, 0), stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        void release.then(() => {
          const failure: AssistantMessage = { ...partial, stopReason: 'aborted', errorMessage: 'released' };
          events.push({ type: 'error', reason: 'aborted', error: failure });
          events.end(failure);
        });
      });
      return events;
    },
  };
}

async function context(runtime: () => PiAgentModelRuntime) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-director-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const app = createApp({
    database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY, piAgentRuntimeFactory: runtime,
  });
  apps.push(app);
  await app.ready();
  const character = repositories.characters.create({
    id: ids.character, name: 'Aster', description: 'A careful archivist.', personality: '', scenario: '',
    firstMessage: '', alternateGreetings: [], tags: [],
  });
  const persona = repositories.personas.create({
    id: ids.persona, name: 'Traveler', description: 'A curious visitor.', isDefault: true,
  });
  const provider = repositories.providerProfiles.create({
    id: ids.provider, name: 'Local', baseUrl: model.baseUrl, model: model.id, secretRef: 'test-secret',
  });
  const preset = repositories.presets.create({
    id: ids.preset, name: 'Role chat', kind: 'chat', settings: {
      tokenizer: TokenizerId.NONE,
      prompts: [
        { identifier: 'main', role: 'system', content: 'Template style' },
        { identifier: 'chatHistory', marker: true },
      ],
      prompt_order: [{ character_id: character.id, order: [
        { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
      ] }],
    },
  });
  const conversation = repositories.conversations.create({
    id: ids.conversation, characterId: character.id, personaId: persona.id, title: 'Archive visit',
  });
  const configuration = repositories.saveAgentConfigurations.create({
    id: ids.configuration, conversationId: conversation.id, sourcePresetId: preset.id,
    sourcePresetRevision: preset.revision, name: preset.name, settings: preset.settings,
  });
  expect(repositories.globalGenerationConfig.update(0, {
    providerId: provider.id, chatPresetId: preset.id,
  }).ok).toBe(true);
  return { app, database, repositories, character, conversation, configuration, preset };
}

function parse(payload: string) {
  return payload.trim().split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\r?\n/);
    return {
      event: lines.find((line) => line.startsWith('event: '))?.slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>,
    };
  });
}

async function generate(app: ReturnType<typeof createApp>, revision: number) {
  return app.inject({
    method: 'POST', url: `/api/conversations/${ids.conversation}/generations`,
    payload: { conversationRevision: revision, mode: 'normal', userText: 'Hello' },
  });
}

describe('per-Save Pi Scene Director', () => {
  it('reconstructs a fresh platform-tool-only Agent with immutable precedence and current private Preset', async () => {
    const contexts: Context[] = [];
    const requests: Array<{ options: Record<string, unknown>; payload: unknown }> = [];
    const customModel = { ...model, provider: 'custom-openai-compatible' } as Model<'openai-completions'>;
    const runtime = completedRuntime(['First agent reply', 'Second agent reply'], contexts, requests, customModel);
    const seeded = await context(() => runtime);
    const worldbook = seeded.repositories.worldbooks.create({
      id: '018f0000-0000-7000-8000-000000000220', name: 'Rules', description: '', enabled: true, isGlobal: true,
    });
    seeded.repositories.worldbookEntries.create({
      id: '018f0000-0000-7000-8000-000000000221', worldbookId: worldbook.id,
      keys: [], content: 'The archive must never burn.', enabled: true, constant: true, position: 0, order: 0,
    });
    seeded.repositories.presets.create({
      id: seeded.configuration.id, name: 'Legacy private owner', kind: 'chat', settings: {},
    });
    seeded.repositories.extensionAssets.create({
      id: '018f0000-0000-7000-8000-000000000223', ownerKind: 'preset', ownerId: seeded.configuration.id,
      kind: 'tavern_helper', sourceKey: 'legacy-hook', ordinal: 0, enabled: true,
      payload: { id: 'legacy-hook', type: 'script', name: 'Legacy hook', enabled: true, content: '', button: {} },
    });
    const legacyTrust = (await seeded.app.inject({
      method: 'POST', url: `/api/extension-trust/preset/${seeded.configuration.id}/grant`,
    })).json() as { bundleDigest: string };
    const ignoredLegacyInjection = 'LEGACY-PROMPT-INJECTION-MUST-BE-IGNORED'.repeat(10_000);
    seeded.repositories.extensionStates.create({
      id: '018f0000-0000-7000-8000-000000000222',
      scope: 'conversation',
      scopeId: ids.conversation,
      value: {
        runtimePromptInjections: {
          legacy: {
            ownerKind: 'preset', ownerId: seeded.configuration.id, bundleDigest: legacyTrust.bundleDigest,
            value: { role: 'system', position: 'before', content: ignoredLegacyInjection },
          },
        },
      },
    });
    expect(seeded.repositories.saveAgentConfigurations.update(seeded.configuration.id, 0, {
      settings: {
        temperature: 0.4,
        max_tokens: 64,
        reasoning_effort: 'max',
        top_p: 0.8,
        top_k: 40,
        min_p: 0.05,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
        seed: 1234,
        stop: ['END'],
        prompts: [{ identifier: 'style', role: 'system', content: 'Write in clipped sentences.' }],
        prompt_order: [{ character_id: seeded.character.id, order: [{ identifier: 'style', enabled: true }] }],
      },
    }).ok).toBe(true);

    const first = await generate(seeded.app, 0);
    expect(first.statusCode).toBe(200);
    expect(parse(first.payload).filter(({ event }) => event === 'delta').map(({ data }) => data.text).join(''))
      .toBe('First agent reply');
    expect((await seeded.app.inject({
      method: 'POST', url: `/api/conversations/${ids.conversation}/prompt-preview`, payload: {},
    })).statusCode).toBe(404);
    expect((await seeded.app.inject({
      method: 'POST', url: `/api/conversations/${ids.conversation}/generation-candidates`, payload: {},
    })).statusCode).toBe(404);
    expect((await seeded.app.inject({
      method: 'POST', url: `/api/conversations/${ids.conversation}/generations`,
      payload: { conversationRevision: 1, mode: 'continue' },
    })).statusCode).toBe(400);
    expect(first.payload).not.toContain('PRIVATE-CHAIN-OF-THOUGHT');
    expect(seeded.repositories.saveAgentConfigurations.update(seeded.configuration.id, 1, {
      settings: {
        prompts: [{ identifier: 'style', role: 'system', content: 'Write with lyrical cadence.' }],
        prompt_order: [{ character_id: seeded.character.id, order: [{ identifier: 'style', enabled: true }] }],
      },
    }).ok).toBe(true);
    expect(seeded.repositories.presets.delete(seeded.preset.id, seeded.preset.revision).ok).toBe(true);
    await generate(seeded.app, 1);

    const firstSystem = contexts[0]!.systemPrompt ?? '';
    expect(firstSystem.indexOf('[1 PLATFORM CONTRACT')).toBeLessThan(firstSystem.indexOf('[2 WORLD RULES]'));
    expect(firstSystem.indexOf('[2 WORLD RULES]')).toBeLessThan(firstSystem.indexOf('[3 CHARACTER IDENTITY]'));
    expect(firstSystem.indexOf('[3 CHARACTER IDENTITY]')).toBeLessThan(firstSystem.indexOf('[4 PRIVATE SAVE PRESET'));
    expect(firstSystem).toContain('The archive must never burn.');
    expect(firstSystem).toContain(seeded.character.description);
    expect(firstSystem).toContain('Write in clipped sentences.');
    expect(JSON.stringify(contexts[0])).not.toContain('LEGACY-PROMPT-INJECTION-MUST-BE-IGNORED');
    expect(firstSystem).not.toContain('Template style');
    expect(contexts[0]!.tools?.map((tool) => tool.name)).toEqual([
      'save_state_read', 'world_query', 'deterministic_check', 'scene_patch_stage',
    ]);
    expect(contexts[0]!.tools?.map((tool) => tool.name).join(' ')).not.toMatch(
      /bash|shell|file|network|http|code|exec/i,
    );
    expect(contexts[1]!.systemPrompt).toContain('Write with lyrical cadence.');
    expect(requests[0]).toMatchObject({
      options: {
        temperature: 0.4,
        maxTokens: 64,
        reasoning: 'max',
        samplingParams: {
          top_p: 0.8, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, presence_penalty: 0.1,
          seed: 1234,
          stop: expect.any(Array),
        },
      },
      payload: expect.objectContaining({
        top_p: 0.8, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, presence_penalty: 0.1,
        seed: 1234,
        stop: expect.any(Array),
      }),
    });
    expect(contexts[1]!.messages.some((message) => (
      message.role === 'assistant' && message.content.some((block) => block.type === 'text' && block.text === 'First agent reply')
    ))).toBe(true);
    expect(seeded.repositories.messageVariants.listByConversationId(seeded.conversation.id).map((variant) => ({
      content: variant.content,
      document: variant.document,
    }))).toEqual([
      {
        content: 'First agent reply',
        document: { version: 1, blocks: [{ type: 'markdown', content: 'First agent reply' }] },
      },
      {
        content: 'Second agent reply',
        document: { version: 1, blocks: [{ type: 'markdown', content: 'Second agent reply' }] },
      },
    ]);
    const runs = seeded.repositories.agentRuns.listByConversationId(seeded.conversation.id);
    expect(runs.map((run) => run.revisions.saveAgentConfiguration.revision)).toEqual([1, 2]);
    expect(runs).toEqual(runs.map(() => expect.objectContaining({
      status: 'completed', counts: { modelTurns: 1, toolCalls: 0 },
      usage: { inputTokens: 4, outputTokens: 2 },
      promptPlan: {
        schemaVersion: 1,
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        promptTokens: expect.any(Number),
        messageCount: expect.any(Number),
      },
    })));
    expect(JSON.stringify(runs)).not.toContain('PRIVATE-CHAIN-OF-THOUGHT');

    const stagedContexts: Context[] = [];
    const staged = new SceneDirectorExecution({
      repositories: seeded.repositories,
      generationId: '018f0000-0000-7000-8000-000000000230',
      snapshotId: '018f0000-0000-7000-8000-000000000231',
      payload: seeded.repositories.generationSnapshots.list().at(-1)!.payload as unknown as PromptSnapshotPayload,
      provider: seeded.repositories.providerProfiles.get(ids.provider)!,
      configuration: seeded.repositories.saveAgentConfigurations.getByConversationId(ids.conversation)!,
      playerInput: 'Staged state',
      runtimeFactory: () => completedRuntime(['Staged state reply'], stagedContexts),
      effectiveSceneState: { phase: 'staged', points: 9, 主角: { 金钱: 20 } },
      scenePromptAdditions: [{ role: 'system', content: 'SCENE-TURN-RULE' }],
    });
    await staged.validatePromptBudget(oneTokenRuntime);
    for await (const _event of staged.events(new AbortController().signal)) { /* consume */ }
    const stagedTerminal = await staged.settle('completed');
    if (stagedTerminal !== undefined) staged.commitTerminal(stagedTerminal);
    expect(stagedContexts[0]?.systemPrompt).toContain('"phase":"staged"');
    expect(stagedContexts[0]?.systemPrompt).toContain('/主角/金钱 (number)');
    expect(stagedContexts[0]?.systemPrompt).toContain('Copy these paths exactly');
    expect(stagedContexts[0]?.systemPrompt).toContain('SCENE-TURN-RULE');

  });

  it('tiers activated Worldbook rules to about half of the Agent prompt while keeping deferred lore queryable', async () => {
    const contexts: Context[] = [];
    const runtime = oneToolRuntime(contexts, 'world_query', { query: 'TIERED_RULE_6', limit: 4 }, '分级规则查询完成。');
    const seeded = await context(() => runtime);
    const book = seeded.repositories.worldbooks.create({
      id: randomUUID(), name: 'Tiered rules', description: '', enabled: true, isGlobal: true,
    });
    for (let index = 0; index < 10; index += 1) {
      seeded.repositories.worldbookEntries.create({
        id: randomUUID(), worldbookId: book.id, sourceUid: `tier-${index}`, sourceOrdinal: index,
        keys: index === 1 ? ['Hello'] : [], content: `TIERED_RULE_${index}`, enabled: true, constant: index !== 1,
        priority: index, order: index, ignoreBudget: index === 0,
      });
    }

    const response = await generate(seeded.app, 0);
    expect(parse(response.payload).at(-1)).toEqual({ event: 'completed', data: { finishReason: 'stop' } });
    const system = contexts[0]!.systemPrompt ?? '';
    expect(system.match(/TIERED_RULE_\d/g)).toHaveLength(5);
    for (const included of [0, 1, 7, 8, 9]) expect(system).toContain(`TIERED_RULE_${included}`);
    for (const deferred of [2, 3, 4, 5, 6]) expect(system).not.toContain(`TIERED_RULE_${deferred}`);
    expect(system).toContain('5 of 10 activated Worldbook entries');
    const queryResult = contexts[1]!.messages.find((message) => (
      message.role === 'toolResult' && message.toolName === 'world_query'
    ));
    expect(JSON.stringify(queryResult)).toContain('TIERED_RULE_6');
  });

  it('filters Save samplers by built-in Pi API and forwards the Save seed', async () => {
    const requests: Array<{ options: Record<string, unknown>; payload: unknown }> = [];
    let runtime = completedRuntime(['Builtin reply'], [], requests);
    const seeded = await context(() => runtime);
    expect(seeded.repositories.saveAgentConfigurations.update(seeded.configuration.id, 0, {
      settings: {
        ...seeded.configuration.settings,
        top_p: 0.7,
        top_k: 33,
        min_p: 0.04,
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
        seed: 9876,
        stop: ['HALT'],
      },
    }).ok).toBe(true);

    expect(parse((await generate(seeded.app, 0)).payload).at(-1)).toEqual({
      event: 'completed', data: { finishReason: 'stop' },
    });
    expect(requests[0]).toMatchObject({
      options: {
        samplingParams: {
          top_p: 0.7,
          frequency_penalty: 0.3,
          presence_penalty: 0.2,
          seed: 9876,
          stop: ['HALT'],
        },
      },
      payload: expect.objectContaining({
        top_p: 0.7,
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
        seed: 9876,
        stop: ['HALT'],
      }),
    });
    expect(requests[0]!.options.samplingParams).not.toHaveProperty('top_k');
    expect(requests[0]!.options.samplingParams).not.toHaveProperty('min_p');
    expect(requests[0]!.payload).not.toHaveProperty('top_k');
    expect(requests[0]!.payload).not.toHaveProperty('min_p');

    const responseRequests: Array<{ options: Record<string, unknown>; payload: unknown }> = [];
    const responseModel: Model<'openai-responses'> = {
      ...model,
      api: 'openai-responses',
      provider: 'openai',
    };
    runtime = completedRuntime(['Responses reply'], [], responseRequests, responseModel);
    expect(parse((await generate(seeded.app, 1)).payload).at(-1)).toEqual({
      event: 'completed', data: { finishReason: 'stop' },
    });
    expect(responseRequests[0]).toMatchObject({
      options: { samplingParams: { top_p: 0.7 } },
      payload: expect.objectContaining({ top_p: 0.7 }),
    });
    for (const unsupported of ['top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'seed', 'stop']) {
      expect(responseRequests[0]!.options.samplingParams).not.toHaveProperty(unsupported);
      expect(responseRequests[0]!.payload).not.toHaveProperty(unsupported);
    }
  });

  it('commits no assistant response for empty, failed, cancelled, or exhausted runs', async () => {
    let runtime = completedRuntime(['']);
    const seeded = await context(() => runtime);
    expect(parse((await generate(seeded.app, 0)).payload).at(-1)).toEqual({
      event: 'failed', data: { code: 'empty_narrative' },
    });
    runtime = failedRuntime('Unsafe partial', 'AUDIT-SECRET');
    expect(parse((await generate(seeded.app, 1)).payload).at(-1)).toEqual({
      event: 'failed', data: { code: 'connection' },
    });
    const counter = { calls: 0 };
    runtime = loopingRuntime(counter);
    expect(parse((await generate(seeded.app, 2)).payload).at(-1)).toEqual({
      event: 'failed', data: { code: 'run_budget_exhausted' },
    });
    expect(counter.calls).toBe(8);

    const entered = deferred<void>();
    runtime = cancellableRuntime(entered);
    const cancelService = createGenerationService({
      database: seeded.database, repositories: seeded.repositories,
      piAgentRuntimeFactory: () => runtime,
    });
    const controller = new AbortController();
    const started = await cancelService.start({
      conversationId: ids.conversation, conversationRevision: 3, mode: 'normal', userText: 'Cancel',
    }, controller.signal);
    if (!started.ok) throw new Error(started.reason);
    const iterator = started.events[Symbol.asyncIterator]();
    await iterator.next();
    const streamed = iterator.next();
    await entered.promise;
    await streamed;
    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'aborted' } });

    const release = deferred<void>();
    const timeoutService = createGenerationService({
      database: seeded.database, repositories: seeded.repositories,
      piAgentRuntimeFactory: () => hangingRuntime(release.promise), sceneDirectorLimits: { timeoutMs: 20 },
    });
    const timed = await timeoutService.start({
      conversationId: ids.conversation, conversationRevision: 4, mode: 'normal', userText: 'Wait',
    });
    if (!timed.ok) throw new Error(timed.reason);
    const timedEvents: SaveAgentRuntimeEvent[] = [];
    for await (const event of timed.events) timedEvents.push(event);
    expect(timedEvents.at(-1)).toEqual({ type: 'failed', code: 'timeout_budget_exhausted' });
    const frozenTimedAudit = seeded.repositories.agentRuns.listByConversationId(ids.conversation).at(-1)!;
    release.resolve(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seeded.repositories.agentRuns.get(frozenTimedAudit.id)).toEqual(frozenTimedAudit);

    const preAbortContexts: Context[] = [];
    runtime = completedRuntime(['Must not run'], preAbortContexts);
    const preAbortService = createGenerationService({
      database: seeded.database, repositories: seeded.repositories,
      piAgentRuntimeFactory: () => runtime,
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const preAborted = await preAbortService.start({
      conversationId: ids.conversation, conversationRevision: 5, mode: 'normal', userText: 'Already cancelled',
    }, alreadyAborted.signal);
    if (!preAborted.ok) throw new Error(preAborted.reason);
    const preAbortEvents: SaveAgentRuntimeEvent[] = [];
    for await (const event of preAborted.events) preAbortEvents.push(event);
    expect(preAbortEvents.at(-1)).toEqual({ type: 'aborted' });
    expect(preAbortContexts).toEqual([]);

    runtime = completedRuntime(['Must roll back']);
    const auditFailureService = createGenerationService({
      database: seeded.database, repositories: seeded.repositories,
      piAgentRuntimeFactory: () => runtime,
    });
    const originalAgentRunUpdate = seeded.repositories.agentRuns.update;
    let injectedFailures = 1;
    seeded.repositories.agentRuns.update = (...args) => {
      if (injectedFailures-- > 0) throw new Error('injected agent audit failure');
      return originalAgentRunUpdate(...args);
    };
    try {
      const auditFailure = await auditFailureService.start({
        conversationId: ids.conversation, conversationRevision: 6, mode: 'normal', userText: 'Audit failure',
      });
      if (!auditFailure.ok) throw new Error(auditFailure.reason);
      const auditFailureEvents: SaveAgentRuntimeEvent[] = [];
      for await (const event of auditFailure.events) auditFailureEvents.push(event);
      expect(auditFailureEvents.at(-1)).toEqual({ type: 'failed', code: 'agent_audit_failed' });
      expect(auditFailureService.isConversationActive(ids.conversation)).toBe(false);
    } finally {
      seeded.repositories.agentRuns.update = originalAgentRunUpdate;
    }

    const overBudgetContexts: Context[] = [];
    const beforeBudgetConversation = seeded.repositories.conversations.get(ids.conversation)!;
    const beforeBudgetMessages = seeded.repositories.messages.listByConversationId(ids.conversation);
    const beforeBudgetSnapshots = seeded.repositories.generationSnapshots.list().length;
    const beforeBudgetConsumed = (seeded.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM consumed_generation_snapshots',
    ).get() as { count: number }).count;
    const overBudgetService = createGenerationService({
      database: seeded.database,
      repositories: seeded.repositories,
      piAgentRuntimeFactory: () => completedRuntime(['Must not run'], overBudgetContexts),
      tokenizerRuntime: unitTokenizerRuntime({
        countMessages: async (messages) => messages[0]?.content.includes('[1 PLATFORM CONTRACT')
          ? beforeBudgetConversation.maxPromptTokens + 1
          : 1,
        countText: async () => 0,
      }),
    });
    await expect(overBudgetService.start({
      conversationId: ids.conversation,
      conversationRevision: beforeBudgetConversation.revision,
      mode: 'normal',
      userText: 'Oversized Agent plan',
    })).resolves.toEqual({ ok: false, reason: 'context_overflow' });
    expect(overBudgetService.isConversationActive(ids.conversation)).toBe(false);
    expect(overBudgetContexts).toEqual([]);
    expect(seeded.repositories.conversations.get(ids.conversation)).toEqual(beforeBudgetConversation);
    expect(seeded.repositories.messages.listByConversationId(ids.conversation)).toEqual(beforeBudgetMessages);
    expect(seeded.repositories.generationSnapshots.list()).toHaveLength(beforeBudgetSnapshots);
    expect((seeded.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM consumed_generation_snapshots',
    ).get() as { count: number }).count).toBe(beforeBudgetConsumed);

    expect(seeded.repositories.messageVariants.listByConversationId(ids.conversation)).toEqual([]);
    const runs = seeded.repositories.agentRuns.listByConversationId(ids.conversation);
    expect(runs.map(({ status }) => status)).toEqual([
      'failed', 'failed', 'budget_exhausted', 'aborted', 'budget_exhausted', 'aborted', 'failed',
    ]);
    expect(runs[2]).toMatchObject({ counts: { modelTurns: 8 }, failureCode: 'run_budget_exhausted' });
    expect(runs[2]!.trace.filter((entry) => entry.type === 'model-request')).toHaveLength(8);
    expect(runs[2]!.trace.filter((entry) => entry.type === 'tool-call')).toHaveLength(8);
    expect(runs[4]).toMatchObject({
      limits: { maxModelTurns: 8, maxToolCalls: 16, timeoutMs: 20 }, failureCode: 'timeout_budget_exhausted',
    });
    expect(seeded.repositories.generationSnapshots.list()).toEqual([]);
    expect((seeded.database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM consumed_generation_snapshots',
    ).get() as { count: number }).count).toBe(0);
    expect(JSON.stringify(runs)).not.toContain('AUDIT-SECRET');
    const inspector = await seeded.app.inject({
      method: 'GET', url: `/api/development/agent-runs?conversationId=${ids.conversation}`,
    });
    expect(inspector.statusCode).toBe(200);
    expect(inspector.json()).toHaveLength(runs.length);
    expect(inspector.json().map((run: { status: string }) => run.status)).toEqual(
      [...runs].reverse().map((run) => run.status),
    );
    expect(inspector.payload).not.toContain('AUDIT-SECRET');
    expect(inspector.payload).not.toContain('PRIVATE-CHAIN-OF-THOUGHT');
    expect(inspector.payload).not.toContain('Unsafe partial');
    expect(inspector.json().find((run: { id: string }) => run.id === runs[2]!.id)).toMatchObject({
      status: 'budget_exhausted',
      activities: expect.arrayContaining([
        expect.objectContaining({ kind: 'scene-action', label: 'Performing a Scene action' }),
      ]),
    });
    expect((await seeded.app.inject({
      method: 'GET', url: `/api/development/agent-runs/${runs[2]!.id}`,
    })).statusCode).toBe(404);

  });
});
