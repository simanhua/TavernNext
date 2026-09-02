import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import type { PiAgentModelRuntime } from '@tavernnext/provider-openai-compatible';
import { describe, expect, it } from 'vitest';
import {
  ActionOptionsRuntime,
  generatePostNarrativeActionOptions,
} from '../src/services/action-options-runtime.js';

const usage: Usage = {
  input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<'openai-completions'> = {
  id: 'options-model', name: 'Options Model', api: 'openai-completions', provider: 'test',
  baseUrl: 'http://127.0.0.1:8080/v1', reasoning: false, input: ['text'],
  cost: usage.cost, contextWindow: 128_000, maxTokens: 4_096,
};
const staged = [
  { kind: 'smooth', text: 'Observe the gate.' },
  { kind: 'smooth', text: 'Ask the guide.' },
  { kind: 'engage', text: 'Challenge the warning.' },
  { kind: 'advance', text: 'Enter the city at dawn.' },
  { kind: 'mainline', text: 'Follow the hidden clue.' },
  { kind: 'twist', text: 'Trust the unexpected rival.' },
  { kind: 'dark', text: 'Take the forbidden road.' },
] as const;

function toolRuntime(contexts: Context[]): PiAgentModelRuntime {
  return {
    model,
    stream(_model, context, options) {
      contexts.push({
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        messages: structuredClone(context.messages),
        ...(context.tools === undefined ? {} : { tools: context.tools.map((tool) => ({
          name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters),
        })) }),
      });
      expect((options as unknown as { toolChoice?: { function?: { name?: string } } }).toolChoice?.function?.name)
        .toBe('action_options_stage');
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const toolCall: ToolCall = {
          type: 'toolCall', id: 'options-1', name: 'action_options_stage', arguments: { options: staged },
        };
        const partial: AssistantMessage = {
          role: 'assistant', content: [toolCall], api: model.api, provider: model.provider,
          model: model.id, usage, stopReason: 'pending', timestamp: Date.now(),
        };
        events.push({ type: 'start', partial });
        events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial });
        const message = { ...partial, stopReason: 'toolUse' as const };
        events.push({ type: 'done', reason: 'toolUse', message });
        events.end(message);
      });
      return events;
    },
  };
}

describe('platform Action Options runtime', () => {
  it('stages exactly seven ordered Action Options behind one Agent Tool', async () => {
    const runtime = new ActionOptionsRuntime();
    const result = await runtime.tool().execute('test', { options: staged });
    expect(result.details).toMatchObject({ ok: true, count: 7 });
    expect(runtime.options()).toEqual(staged.map((option, index) => ({ id: `option-${index + 1}`, ...option })));
    await expect(runtime.tool().execute('invalid', { options: [...staged].reverse() }))
      .rejects.toThrow('action_options_invalid');
  });

  it('forces the shared tool after narrative generation and returns its typed options', async () => {
    const contexts: Context[] = [];
    const result = await generatePostNarrativeActionOptions({
      runtime: toolRuntime(contexts),
      narrative: 'The gate opened after the traveler found the seal.',
      playerInput: 'Open the gate.',
      sceneState: { location: 'North gate', quest: 'Find the seal' },
    });
    expect(result).toMatchObject({ ok: true, options: expect.any(Array) });
    expect(result.ok && result.options).toHaveLength(7);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.systemPrompt).toContain('post-narrative Action Options planner');
    expect(JSON.stringify(contexts[0]?.messages)).toContain('The gate opened');
  });
});
