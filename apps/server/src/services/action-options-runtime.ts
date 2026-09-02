import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  ActionOptionSchema,
  type ActionOption,
  type ActionOptionKind,
} from '@tavernnext/domain';
import type { PiAgentModelRuntime } from '@tavernnext/provider-openai-compatible';
import { Type } from 'typebox';

const ACTION_OPTION_KINDS = [
  'smooth', 'smooth', 'engage', 'advance', 'mainline', 'twist', 'dark',
] as const satisfies readonly ActionOptionKind[];
const MAX_NARRATIVE_CHARS = 24_000;
const MAX_STATE_CHARS = 16_000;

function boundedTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}

function boundedJson(value: unknown, maximum: number): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= maximum ? serialized : `${serialized.slice(0, maximum)}…`;
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: structuredClone(value) };
}

export class ActionOptionsRuntime {
  private staged: ActionOption[] = [];

  options(): ActionOption[] {
    return structuredClone(this.staged);
  }

  tool(): AgentTool {
    const runtime = this;
    return {
      name: 'action_options_stage',
      label: 'Stage Action Options',
      description: 'Stage exactly seven concise player actions after the narrative. Preserve the required order and make every option materially distinct and actionable.',
      parameters: Type.Object({
        options: Type.Array(Type.Object({
          kind: Type.Union([
            Type.Literal('smooth'), Type.Literal('engage'), Type.Literal('advance'),
            Type.Literal('mainline'), Type.Literal('twist'), Type.Literal('dark'),
          ]),
          text: Type.String({ minLength: 1, maxLength: 300 }),
        }, { additionalProperties: false }), { minItems: 7, maxItems: 7 }),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_toolCallId, raw) {
        const input = raw as { options?: Array<{ kind?: unknown; text?: unknown }> };
        if (!Array.isArray(input.options) || input.options.length !== ACTION_OPTION_KINDS.length) {
          throw new Error('action_options_invalid');
        }
        const parsed = input.options.map((option, index) => ActionOptionSchema.safeParse({
          id: `option-${index + 1}`,
          kind: option.kind,
          text: option.text,
        }));
        if (parsed.some((result) => !result.success)
          || parsed.some((result, index) => result.success && result.data.kind !== ACTION_OPTION_KINDS[index])) {
          throw new Error('action_options_invalid');
        }
        const options = parsed.map((result) => result.success ? result.data : undefined)
          .filter((option): option is ActionOption => option !== undefined);
        if (new Set(options.map((option) => option.text)).size !== options.length) {
          throw new Error('action_options_invalid');
        }
        runtime.staged = structuredClone(options);
        return toolResult({ ok: true, count: runtime.staged.length });
      },
    };
  }
}

export type PostNarrativeActionOptionsResult =
  | { ok: true; options: ActionOption[] }
  | { ok: false; code: 'action_options_generation_failed' | 'aborted' };

export async function generatePostNarrativeActionOptions(input: {
  runtime: PiAgentModelRuntime;
  narrative: string;
  playerInput: string;
  sceneState: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<PostNarrativeActionOptionsResult> {
  const staged = new ActionOptionsRuntime();
  const tool = staged.tool();
  let turns = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: [
        'You are TavernNext post-narrative Action Options planner.',
        'The narrative is already complete. Do not rewrite, continue, summarize, or critique it.',
        'Call action_options_stage exactly once with seven actions in this order:',
        '1 smooth continuation; 2 distinct smooth continuation; 3 deepen the current interaction;',
        '4 materially advance time or location; 5 pursue the serious main plot or a concrete clue;',
        '6 introduce a surprising but coherent development; 7 offer a darker or higher-risk development.',
        'Every action must be specific to the completed narrative and phrased as something the player can submit next.',
      ].join(' '),
      model: input.runtime.model,
      thinkingLevel: 'off',
      tools: [tool],
      messages: [],
    },
    streamFn: (model, context, options) => input.runtime.stream(model, context, {
      ...options,
      maxTokens: 2_048,
      temperature: 0.7,
      toolChoice: { type: 'function', function: { name: 'action_options_stage' } },
    } as unknown as NonNullable<Parameters<PiAgentModelRuntime['stream']>[2]>),
    shouldStopAfterTurn: () => staged.options().length === 7 || ++turns >= 2,
    toolExecution: 'sequential',
  });
  const abort = () => agent.abort();
  if (input.signal?.aborted) return { ok: false, code: 'aborted' };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    await agent.prompt(JSON.stringify({
      playerInput: boundedTail(input.playerInput, 2_000),
      completedNarrative: boundedTail(input.narrative, MAX_NARRATIVE_CHARS),
      sceneState: boundedJson(input.sceneState, MAX_STATE_CHARS),
    }));
    const options = staged.options();
    return options.length === 7
      ? { ok: true, options }
      : { ok: false, code: 'action_options_generation_failed' };
  } catch {
    return { ok: false, code: input.signal?.aborted ? 'aborted' : 'action_options_generation_failed' };
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}
