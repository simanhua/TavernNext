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
});
