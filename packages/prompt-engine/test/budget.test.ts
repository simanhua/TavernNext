import { describe, expect, it } from 'vitest';
import { allocateGroupedPromptBudget, allocatePromptBudget } from '../src/index.js';

describe('deterministic token budget ledger', () => {
  const blocks = [
    { source: 'system', policy: 'immutable' as const, value: 'system', tokens: 1 },
    { source: 'history:old', policy: 'history' as const, value: 'old', tokens: 2 },
    { source: 'history:new', policy: 'history' as const, value: 'new', tokens: 1 },
    { source: 'example:0', policy: 'optional' as const, value: 'example', tokens: 1 },
  ];

  it('keeps a newest-first contiguous history suffix and then optional blocks', async () => {
    const calls: string[] = [];
    const result = await allocatePromptBudget({
      maxTokens: 3,
      blocks,
      countTokens: async (block) => {
        calls.push(block.source);
        return block.tokens;
      },
    });

    expect(calls).toEqual(['system', 'history:old', 'history:new', 'example:0']);
    expect(result).toEqual({
      ok: true,
      includedBlockIndexes: [0, 2, 3],
      includedSources: ['system', 'history:new', 'example:0'],
      totalTokens: 3,
      tokenBreakdown: [
        { source: 'system', includedTokens: 1, omittedTokens: 0 },
        { source: 'history:old', includedTokens: 0, omittedTokens: 2, reason: 'history_budget' },
        { source: 'history:new', includedTokens: 1, omittedTokens: 0 },
        { source: 'example:0', includedTokens: 1, omittedTokens: 0 },
      ],
    });
  });

  it('tracks selected block identity when ledger sources are duplicated', async () => {
    const result = await allocatePromptBudget({
      maxTokens: 1,
      blocks: [
        { source: 'history:same', policy: 'history' as const, value: 'old' },
        { source: 'history:same', policy: 'history' as const, value: 'new' },
      ],
      countTokens: async () => 1,
    });

    expect(result).toMatchObject({
      ok: true,
      includedBlockIndexes: [1],
      includedSources: ['history:same'],
      tokenBreakdown: [
        { source: 'history:same', includedTokens: 0, omittedTokens: 1, reason: 'history_budget' },
        { source: 'history:same', includedTokens: 1, omittedTokens: 0 },
      ],
    });
  });

  it('supports ST Text strict variable-block headroom without changing Chat boundaries', async () => {
    const history = [
      { source: 'history:old', policy: 'history' as const, value: 'old' },
      { source: 'history:new', policy: 'history' as const, value: 'new' },
    ];
    const inclusive = await allocatePromptBudget({
      maxTokens: 2, blocks: history, countTokens: async () => 1,
    });
    const strict = await allocatePromptBudget({
      maxTokens: 2, blocks: history, countTokens: async () => 1, fit: 'strict',
    });

    expect(inclusive).toMatchObject({ ok: true, includedBlockIndexes: [0, 1], totalTokens: 2 });
    expect(strict).toMatchObject({ ok: true, includedBlockIndexes: [1], totalTokens: 1 });
  });

  it('includes exact-boundary blocks and reports immutable overflow', async () => {
    const exact = await allocatePromptBudget({
      maxTokens: 4,
      blocks: blocks.slice(0, 3),
      countTokens: async (block) => block.tokens,
    });
    const overflow = await allocatePromptBudget({
      maxTokens: 0,
      blocks: blocks.slice(0, 1),
      countTokens: async (block) => block.tokens,
    });

    expect(exact.ok && exact.includedSources).toEqual(['system', 'history:old', 'history:new']);
    expect(overflow).toMatchObject({ ok: false, code: 'context_overflow', totalTokens: 0 });
    expect(overflow.tokenBreakdown).toEqual([
      { source: 'system', includedTokens: 0, omittedTokens: 1, reason: 'context_overflow' },
    ]);
  });

  it('rejects negative budgets and tokenizer failures deterministically', async () => {
    const negative = await allocatePromptBudget({
      maxTokens: -1,
      blocks: [],
      countTokens: async () => 0,
    });
    const failed = await allocatePromptBudget({
      maxTokens: 1,
      blocks: blocks.slice(0, 1),
      countTokens: async () => { throw new Error('offline'); },
    });

    expect(negative).toMatchObject({ ok: false, code: 'invalid_budget' });
    expect(failed).toMatchObject({ ok: false, code: 'tokenizer_error' });
  });

  it('counts an empty grouped selection and reports omitted blocks by their final marginal cost', async () => {
    const result = await allocateGroupedPromptBudget({
      maxTokens: 3,
      blocks: [
        { source: 'disabled', policy: 'immutable' as const, value: 'hello', omitReason: 'disabled' as const },
      ],
      countSelection: (selected) => 3 + selected.reduce((sum, block) => sum + block.value.length, 0),
    });
    const overflow = await allocateGroupedPromptBudget({
      maxTokens: 2,
      blocks: [],
      countSelection: () => 3,
    });

    expect(result).toMatchObject({
      ok: true,
      totalTokens: 3,
      tokenBreakdown: [
        { source: 'tokenizer:request-framing', includedTokens: 3, omittedTokens: 0 },
        { source: 'disabled', includedTokens: 0, omittedTokens: 5, reason: 'disabled' },
      ],
    });
    expect(overflow).toMatchObject({ ok: false, code: 'context_overflow' });
  });

  it('keeps the longest newest-history suffix when a shorter BPE candidate is larger', async () => {
    const result = await allocateGroupedPromptBudget({
      maxTokens: 1,
      blocks: [
        { source: 'history:old', policy: 'history' as const, value: 'old' },
        { source: 'history:new', policy: 'history' as const, value: 'new' },
      ],
      countSelection: (selected) => {
        const value = selected.map((block) => block.value).join('');
        return ({ '': 0, old: 1, new: 2, oldnew: 1 } as const)[value as '' | 'old' | 'new' | 'oldnew'];
      },
    });

    expect(result).toMatchObject({
      ok: true,
      includedBlockIndexes: [0, 1],
      includedSources: ['history:old', 'history:new'],
      totalTokens: 1,
    });
  });

  it('keeps the longest optional prefix when a shorter BPE candidate is larger', async () => {
    const result = await allocateGroupedPromptBudget({
      maxTokens: 1,
      blocks: [
        { source: 'example:first', policy: 'optional' as const, value: 'first' },
        { source: 'example:second', policy: 'optional' as const, value: 'second' },
      ],
      countSelection: (selected) => {
        const value = selected.map((block) => block.value).join('');
        return ({ '': 0, first: 2, second: 1, firstsecond: 1 } as const)[value as '' | 'first' | 'second' | 'firstsecond'];
      },
    });

    expect(result).toMatchObject({
      ok: true,
      includedBlockIndexes: [0, 1],
      includedSources: ['example:first', 'example:second'],
      totalTokens: 1,
    });
  });

  it('keeps every source in a tokenizer-error ledger even when standalone counting fails early', async () => {
    const result = await allocateGroupedPromptBudget({
      maxTokens: 10,
      blocks: [
        { source: 'first', policy: 'immutable' as const, value: 'first' },
        { source: 'failed', policy: 'immutable' as const, value: 'failed' },
        { source: 'unreached', policy: 'immutable' as const, value: 'unreached' },
      ],
      countSelection: (selected) => {
        if (selected.length === 1 && selected[0]?.source === 'failed') throw new Error('offline');
        return selected.length;
      },
    });

    expect(result).toMatchObject({ ok: false, code: 'tokenizer_error' });
    expect(result.tokenBreakdown.map((entry) => entry.source)).toEqual(['first', 'failed', 'unreached']);
  });

  it('traverses exact candidates in history-then-optional priority and stops at the first fit', async () => {
    const calls: string[] = [];
    const result = await allocateGroupedPromptBudget({
      maxTokens: 3,
      blocks: [
        { source: 'immutable', policy: 'immutable' as const, value: 'I' },
        { source: 'history:old', policy: 'history' as const, value: 'H1' },
        { source: 'history:new', policy: 'history' as const, value: 'H2' },
        { source: 'optional:first', policy: 'optional' as const, value: 'O1' },
        { source: 'optional:second', policy: 'optional' as const, value: 'O2' },
      ],
      countSelection: (selected) => {
        const value = selected.map((block) => block.value).join('+');
        calls.push(value);
        if (value === 'I+H1+H2+O1+O2') return 4;
        if (value === 'I+H1+H2+O1') return 3;
        return selected.length;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      includedBlockIndexes: [0, 1, 2, 3],
      includedSources: ['immutable', 'history:old', 'history:new', 'optional:first'],
      totalTokens: 3,
    });
    expect(calls.slice(5, 7)).toEqual(['I+H1+H2+O1+O2', 'I+H1+H2+O1']);
    expect(calls).toHaveLength(12);
  });

  it('accepts the 4096-candidate boundary without retaining every fitting candidate', async () => {
    const blocksAtBoundary = [
      ...Array.from({ length: 63 }, (_value, index) => ({
        source: `history:${index}`,
        policy: 'history' as const,
        value: `h${index}`,
      })),
      ...Array.from({ length: 63 }, (_value, index) => ({
        source: `optional:${index}`,
        policy: 'optional' as const,
        value: `o${index}`,
      })),
    ];
    let calls = 0;
    const result = await allocateGroupedPromptBudget({
      maxTokens: 1,
      blocks: blocksAtBoundary,
      countSelection: (selected) => {
        calls += 1;
        return selected.length === 0 ? 0 : 1;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      includedBlockIndexes: Array.from({ length: 126 }, (_value, index) => index),
      totalTokens: 1,
    });
    // 126 standalone + first exact candidate + 126 leave-one-out ledger calls.
    expect(calls).toBe(253);
  });

  it('rejects 100x100 and per-dimension/total over-limit inputs before tokenization', async () => {
    const adversarialInputs: Array<Array<{
      source: string;
      policy: 'immutable' | 'history' | 'optional';
      value: number;
    }>> = [
      [
        ...Array.from({ length: 100 }, (_value, index) => ({
          source: `history:${index}`, policy: 'history' as const, value: index,
        })),
        ...Array.from({ length: 100 }, (_value, index) => ({
          source: `optional:${index}`, policy: 'optional' as const, value: index,
        })),
      ],
      Array.from({ length: 101 }, (_value, index) => ({
        source: `history:${index}`, policy: 'history' as const, value: index,
      })),
      Array.from({ length: 257 }, (_value, index) => ({
        source: `immutable:${index}`, policy: 'immutable' as const, value: index,
      })),
    ];

    for (const blocks of adversarialInputs) {
      let calls = 0;
      const result = await allocateGroupedPromptBudget({
        maxTokens: 1,
        blocks,
        countSelection: () => {
          calls += 1;
          return 0;
        },
      });

      expect(result).toMatchObject({ ok: false, code: 'budget_search_limit', totalTokens: 0 });
      expect(calls).toBe(0);
      expect(result.tokenBreakdown).toHaveLength(blocks.length);
      expect(result.tokenBreakdown.every((entry) => (
        entry.includedTokens === 0
        && entry.omittedTokens === 0
        && entry.reason === 'budget_search_limit'
      ))).toBe(true);
    }
  });

  it('evaluates the sole zero-history/zero-optional candidate and only overflows after every candidate fails', async () => {
    let emptyCalls = 0;
    const empty = await allocateGroupedPromptBudget({
      maxTokens: 0,
      blocks: [],
      countSelection: () => {
        emptyCalls += 1;
        return 0;
      },
    });
    let overflowCalls = 0;
    const overflow = await allocateGroupedPromptBudget({
      maxTokens: 1,
      blocks: [
        { source: 'immutable', policy: 'immutable' as const, value: 'I' },
        { source: 'history', policy: 'history' as const, value: 'H' },
        { source: 'optional', policy: 'optional' as const, value: 'O' },
      ],
      countSelection: () => {
        overflowCalls += 1;
        return overflowCalls <= 3 ? 1 : 2;
      },
    });

    expect(empty).toMatchObject({ ok: true, includedBlockIndexes: [], totalTokens: 0 });
    expect(emptyCalls).toBe(1);
    expect(overflow).toMatchObject({ ok: false, code: 'context_overflow' });
    // 3 standalone calls, then all four policy-valid exact candidates.
    expect(overflowCalls).toBe(7);
  });

  it('reports stable ledgers when the tokenizer fails at the first or a middle candidate', async () => {
    const candidateFailure = async (failAt: 'first' | 'middle') => {
      let calls = 0;
      let candidateCalls = 0;
      const result = await allocateGroupedPromptBudget({
        maxTokens: 1,
        blocks: [
          { source: 'immutable', policy: 'immutable' as const, value: 'I' },
          { source: 'history', policy: 'history' as const, value: 'H' },
          { source: 'optional', policy: 'optional' as const, value: 'O' },
        ],
        countSelection: (selected) => {
          calls += 1;
          if (selected.length === 1) return 1;
          candidateCalls += 1;
          if (failAt === 'first' || candidateCalls === 2) throw new Error(`${failAt} candidate offline`);
          return 2;
        },
      });
      return { result, calls };
    };

    const first = await candidateFailure('first');
    const middle = await candidateFailure('middle');

    expect(first.calls).toBe(4);
    expect(middle.calls).toBe(5);
    for (const { result } of [first, middle]) {
      expect(result).toMatchObject({ ok: false, code: 'tokenizer_error', totalTokens: 0 });
      expect(result.tokenBreakdown).toEqual([
        { source: 'immutable', includedTokens: 0, omittedTokens: 1, reason: 'context_overflow' },
        { source: 'history', includedTokens: 0, omittedTokens: 1, reason: 'context_overflow' },
        { source: 'optional', includedTokens: 0, omittedTokens: 1, reason: 'context_overflow' },
      ]);
    }
  });
});
