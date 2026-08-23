import { describe, expect, it, vi } from 'vitest';
import {
  projectRegexViews,
  REGEX_PLACEMENT,
  runOwnedRegexProjection,
  runOwnedRegexProjectionInWorker,
  regexWorkerLimitsForProjection,
  runRegexScripts,
  type RegexWorker,
  type RegexWorkerFactory,
  type TavernRegex,
} from '../src/index.js';

function rule(patch: Partial<TavernRegex> = {}): TavernRegex {
  return {
    id: 'rule', scriptName: 'rule', findRegex: '/<(.*?)>/g', replaceString: '[$1]', trimStrings: [],
    placement: [REGEX_PLACEMENT.AI_OUTPUT], disabled: false, markdownOnly: false, promptOnly: false,
    runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null, ...patch,
  };
}

describe('SillyTavern Regex compatibility engine', () => {
  it('runs ordered replacements and capture groups', () => {
    const result = runRegexScripts('<one> <two>', [rule(), rule({ id: 'second', findRegex: '/\\[(.*?)\\]/g', replaceString: '{$1}' })], {
      placement: REGEX_PLACEMENT.AI_OUTPUT,
    });
    expect(result.value).toBe('{one} {two}');
    expect(result.trace.map((entry) => entry.applied)).toEqual([true, true]);
  });

  it('separates display and prompt-only execution', () => {
    const rules = [rule({ markdownOnly: true }), rule({ id: 'prompt', promptOnly: true, replaceString: '{$1}' })];
    expect(runRegexScripts('<one>', rules, { placement: REGEX_PLACEMENT.AI_OUTPUT, isMarkdown: true }).value).toBe('[one]');
    expect(runRegexScripts('<one>', rules, { placement: REGEX_PLACEMENT.AI_OUTPUT, isPrompt: true }).value).toBe('{one}');
  });

  it('honors edit and depth gates', () => {
    const item = rule({ runOnEdit: false, minDepth: 2, maxDepth: 4 });
    expect(runRegexScripts('<one>', [item], { placement: REGEX_PLACEMENT.AI_OUTPUT, isEdit: true, depth: 3 }).value).toBe('<one>');
    expect(runRegexScripts('<one>', [{ ...item, runOnEdit: true }], { placement: REGEX_PLACEMENT.AI_OUTPUT, isEdit: true, depth: 3 }).value).toBe('[one]');
    expect(runRegexScripts('<one>', [{ ...item, runOnEdit: true }], { placement: REGEX_PLACEMENT.AI_OUTPUT, depth: 5 }).value).toBe('<one>');
  });

  it('supports escaped macro substitution in find expressions', () => {
    const result = runRegexScripts('A.lice', [rule({ findRegex: '/^{{user}}$/g', replaceString: 'friend', substituteRegex: 2 })], {
      placement: REGEX_PLACEMENT.AI_OUTPUT, values: { user: 'A.lice' },
    });
    expect(result.value).toBe('friend');
  });

  it('projects primary Preset rules before Character rules and traces their owners', () => {
    const result = runOwnedRegexProjection('<state:  blue  >', {
      preset: [rule({ id: 'preset', findRegex: '/<state:\\s*(?<value>.*?)\\s*>/g', replaceString: '[$<value>]', trimStrings: [' '] })],
      character: [rule({ id: 'character', findRegex: '/\\[(.*?)\\]/g', replaceString: '{$1}' })],
    }, { placement: REGEX_PLACEMENT.AI_OUTPUT });

    expect(result.value).toBe('{blue}');
    expect(result.trace.map(({ owner, scriptId }) => `${owner}:${scriptId}`)).toEqual([
      'preset:preset',
      'character:character',
    ]);
  });

  it('keeps raw content canonical while separating prompt and display projections', () => {
    const views = projectRegexViews('<secret> <panel>', {
      preset: [
        rule({ id: 'prompt', findRegex: '/<secret>/g', replaceString: '', promptOnly: true }),
        rule({ id: 'display', findRegex: '/<panel>/g', replaceString: '[status]', markdownOnly: true }),
      ],
      character: [],
    }, { placement: REGEX_PLACEMENT.AI_OUTPUT });

    expect(views.raw).toBe('<secret> <panel>');
    expect(views.prompt.value).toBe(' <panel>');
    expect(views.display.value).toBe('<secret> [status]');
  });

  it('terminates timed-out rules, fails open, and continues with a fresh worker', async () => {
    const terminated: string[] = [];
    const factory: RegexWorkerFactory = (request): RegexWorker => {
      if (request.script.id === 'slow') {
        return {
          result: new Promise(() => undefined),
          terminate: () => { terminated.push(request.script.id); },
        };
      }
      return {
        result: Promise.resolve(runRegexScripts(request.raw, [request.script], request.context)),
        terminate: () => { terminated.push(request.script.id); },
      };
    };

    const result = await runOwnedRegexProjectionInWorker('<one>', {
      preset: [rule({ id: 'slow' }), rule({ id: 'fast' })],
      character: [],
    }, { placement: REGEX_PLACEMENT.AI_OUTPUT }, factory, { perRuleMs: 5, aggregateMs: 100 });

    expect(result.value).toBe('[one]');
    expect(result.trace.map(({ scriptId, applied, reason }) => ({ scriptId, applied, reason }))).toEqual([
      { scriptId: 'slow', applied: false, reason: 'timeout' },
      { scriptId: 'fast', applied: true, reason: undefined },
    ]);
    expect(terminated).toEqual(['slow', 'fast']);
  });

  it('stops at the aggregate deadline and traces unexecuted rules as fail-open', async () => {
    const factory: RegexWorkerFactory = (): RegexWorker => ({
      result: new Promise(() => undefined),
      terminate: () => undefined,
    });
    const result = await runOwnedRegexProjectionInWorker('<one>', {
      preset: [rule({ id: 'first' }), rule({ id: 'second' })],
      character: [],
    }, { placement: REGEX_PLACEMENT.AI_OUTPUT }, factory, { perRuleMs: 100, aggregateMs: 5 });

    expect(result.value).toBe('<one>');
    expect(result.trace.map(({ scriptId, reason }) => ({ scriptId, reason }))).toEqual([
      { scriptId: 'first', reason: 'aggregate_timeout' },
      { scriptId: 'second', reason: 'aggregate_timeout' },
    ]);
  });

  it('fails open with trace when the Worker cannot be created', async () => {
    const result = await runOwnedRegexProjectionInWorker('<one>', {
      preset: [rule()], character: [],
    }, { placement: REGEX_PLACEMENT.AI_OUTPUT }, () => { throw new Error('worker unavailable'); }, {
      perRuleMs: 100, aggregateMs: 1_000,
    });

    expect(result.value).toBe('<one>');
    expect(result.trace).toEqual([expect.objectContaining({ scriptId: 'rule', applied: false, reason: 'error' })]);
  });

  it('shares one aggregate deadline across a multi-value projection', async () => {
    vi.useFakeTimers();
    try {
      let workers = 0;
      const limits = regexWorkerLimitsForProjection({ perRuleMs: 100, aggregateMs: 5 });
      const factory: RegexWorkerFactory = () => {
        workers += 1;
        return { result: new Promise(() => undefined), terminate: () => undefined };
      };
      const first = runOwnedRegexProjectionInWorker('<one>', { preset: [rule()], character: [] }, {
        placement: REGEX_PLACEMENT.AI_OUTPUT,
      }, factory, limits);
      await vi.advanceTimersByTimeAsync(5);
      await first;
      const second = await runOwnedRegexProjectionInWorker('<two>', { preset: [rule()], character: [] }, {
        placement: REGEX_PLACEMENT.AI_OUTPUT,
      }, factory, limits);

      expect(workers).toBe(1);
      expect(second.trace).toEqual([expect.objectContaining({ reason: 'aggregate_timeout' })]);
    } finally {
      vi.useRealTimers();
    }
  });

});
