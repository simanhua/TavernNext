import type { PromptCompilationErrorCode, TokenBreakdownEntry, TokenOmissionReason } from './types.js';

export type PromptBudgetPolicy = 'immutable' | 'history' | 'optional';

export interface PromptBudgetBlock<T = unknown> {
  source: string;
  policy: PromptBudgetPolicy;
  value: T;
  omitReason?: TokenOmissionReason;
}

export interface PromptBudgetSuccess {
  ok: true;
  includedBlockIndexes: number[];
  includedSources: string[];
  totalTokens: number;
  tokenBreakdown: TokenBreakdownEntry[];
}

export interface PromptBudgetFailure {
  ok: false;
  code: Extract<
    PromptCompilationErrorCode,
    'invalid_budget' | 'budget_search_limit' | 'tokenizer_error' | 'context_overflow'
  >;
  message: string;
  totalTokens: number;
  tokenBreakdown: TokenBreakdownEntry[];
}

export type PromptBudgetResult = PromptBudgetSuccess | PromptBudgetFailure;

interface CountedBlock<TBlock extends PromptBudgetBlock> {
  block: TBlock;
  tokens: number;
}

function validBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// These hard limits bound grouped search to at most 4,096 exact candidates
// and 4,608 total tokenizer calls (candidate search plus two ledger passes).
const MAX_GROUPED_BLOCKS = 256;
const MAX_GROUPED_HISTORY_BLOCKS = 100;
const MAX_GROUPED_OPTIONAL_BLOCKS = 100;
const MAX_GROUPED_CANDIDATE_EVALUATIONS = 4_096;

/**
 * Allocates blocks whose tokenizer framing is not additive (for example Chat
 * Completion messages). Selection is based on the exact combined candidate;
 * the final ledger uses deterministic leave-one-out marginals plus a stable
 * first-block attribution for shared framing/merge cost, so every entry stays
 * non-negative and included tokens sum to the exact final request count.
 */
export async function allocateGroupedPromptBudget<TBlock extends PromptBudgetBlock>(input: {
  maxTokens: number;
  blocks: readonly TBlock[];
  countSelection: (blocks: readonly TBlock[]) => number | Promise<number>;
  fit?: 'inclusive' | 'strict';
}): Promise<PromptBudgetResult> {
  if (!validBudget(input.maxTokens)) {
    return {
      ok: false,
      code: 'invalid_budget',
      message: 'Prompt token budget must be a non-negative safe integer.',
      totalTokens: 0,
      tokenBreakdown: [],
    };
  }

  const standaloneTokens: Array<number | undefined> = new Array(input.blocks.length);
  const count = async (blocks: readonly TBlock[], source: string): Promise<number> => {
    const tokens = await input.countSelection(blocks);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new TypeError(`Tokenizer returned an invalid count for ${source}`);
    }
    return tokens;
  };
  const failureBreakdown = (reason: TokenOmissionReason = 'context_overflow'): TokenBreakdownEntry[] => input.blocks
    .map((block, index) => ({
      source: block.source,
      includedTokens: 0,
      omittedTokens: standaloneTokens[index] ?? 0,
      reason: block.omitReason ?? reason,
    }));

  const eligibleIndexes = input.blocks.flatMap((block, index) => block.omitReason === undefined ? [index] : []);
  const immutableIndexes = eligibleIndexes.filter((index) => input.blocks[index]!.policy === 'immutable');
  const historyIndexes = eligibleIndexes.filter((index) => input.blocks[index]!.policy === 'history');
  const optionalIndexes = eligibleIndexes.filter((index) => input.blocks[index]!.policy === 'optional');
  const candidateEvaluations = (historyIndexes.length + 1) * (optionalIndexes.length + 1);
  if (input.blocks.length > MAX_GROUPED_BLOCKS
    || historyIndexes.length > MAX_GROUPED_HISTORY_BLOCKS
    || optionalIndexes.length > MAX_GROUPED_OPTIONAL_BLOCKS
    || candidateEvaluations > MAX_GROUPED_CANDIDATE_EVALUATIONS) {
    return {
      ok: false,
      code: 'budget_search_limit',
      message: 'Prompt budget search exceeds the safe evaluation limit.',
      totalTokens: 0,
      tokenBreakdown: failureBreakdown('budget_search_limit'),
    };
  }

  try {
    for (let index = 0; index < input.blocks.length; index += 1) {
      const block = input.blocks[index]!;
      standaloneTokens[index] = await count([block], `standalone:${block.source}`);
    }
  } catch (error) {
    return {
      ok: false,
      code: 'tokenizer_error',
      message: error instanceof Error ? error.message : 'Tokenizer failed while counting a prompt block.',
      totalTokens: 0,
      tokenBreakdown: failureBreakdown(),
    };
  }

  const indexesFor = (historyCount: number, optionalCount: number): Set<number> => new Set([
    ...immutableIndexes,
    ...historyIndexes.slice(historyIndexes.length - historyCount),
    ...optionalIndexes.slice(0, optionalCount),
  ]);
  const blocksFor = (indexes: ReadonlySet<number>): TBlock[] => input.blocks
    .filter((_block, index) => indexes.has(index));

  try {
    let selected: Set<number> | undefined;
    let totalTokens = 0;
    candidateSearch:
    for (let historyCount = historyIndexes.length; historyCount >= 0; historyCount -= 1) {
      for (let optionalCount = optionalIndexes.length; optionalCount >= 0; optionalCount -= 1) {
        const indexes = indexesFor(historyCount, optionalCount);
        const tokens = await count(
          blocksFor(indexes),
          `candidate:history=${historyCount},optional=${optionalCount}`,
        );
        const hasVariableContent = historyCount > 0 || optionalCount > 0;
        const fits = hasVariableContent && input.fit === 'strict'
          ? tokens < input.maxTokens
          : tokens <= input.maxTokens;
        if (!fits) continue;
        selected = indexes;
        totalTokens = tokens;
        break candidateSearch;
      }
    }
    if (selected === undefined) {
      return {
        ok: false,
        code: 'context_overflow',
        message: 'Immutable prompt content exceeds the available context budget.',
        totalTokens: 0,
        tokenBreakdown: failureBreakdown(),
      };
    }

    const includedTokens = new Map<number, number>();
    const selectedIndexes = input.blocks.flatMap((_block, index) => selected.has(index) ? [index] : []);
    let attributedTokens = 0;
    for (const index of selectedIndexes) {
      const without = input.blocks.filter((_block, candidate) => selected.has(candidate) && candidate !== index);
      const withoutTokens = await count(without, `ledger:included:${index}:${input.blocks[index]!.source}`);
      const leaveOneOutMarginal = Math.max(0, totalTokens - withoutTokens);
      const allocation = Math.min(leaveOneOutMarginal, totalTokens - attributedTokens);
      includedTokens.set(index, allocation);
      attributedTokens += allocation;
    }
    if (selectedIndexes.length > 0 && attributedTokens < totalTokens) {
      const sharedCostIndex = selectedIndexes[0]!;
      includedTokens.set(
        sharedCostIndex,
        (includedTokens.get(sharedCostIndex) ?? 0) + totalTokens - attributedTokens,
      );
    }

    const omittedTokens = new Map<number, number>();
    for (let index = 0; index < input.blocks.length; index += 1) {
      if (selected.has(index)) continue;
      const candidate = input.blocks.filter((_block, candidateIndex) => selected.has(candidateIndex) || candidateIndex === index);
      const candidateTokens = await count(candidate, `ledger:omitted:${index}:${input.blocks[index]!.source}`);
      omittedTokens.set(index, Math.max(0, candidateTokens - totalTokens));
    }

    const contentBreakdown = input.blocks.map((block, index): TokenBreakdownEntry => selected.has(index)
      ? { source: block.source, includedTokens: includedTokens.get(index) ?? 0, omittedTokens: 0 }
      : {
          source: block.source,
          includedTokens: 0,
          omittedTokens: omittedTokens.get(index) ?? standaloneTokens[index] ?? 0,
          reason: block.omitReason ?? (block.policy === 'history' ? 'history_budget' : 'optional_budget'),
        });
    const framingBreakdown: TokenBreakdownEntry[] = selectedIndexes.length === 0 && totalTokens > 0
      ? [{ source: 'tokenizer:request-framing', includedTokens: totalTokens, omittedTokens: 0 }]
      : [];

    return {
      ok: true,
      includedBlockIndexes: input.blocks.flatMap((_block, index) => selected.has(index) ? [index] : []),
      includedSources: input.blocks.flatMap((block, index) => selected.has(index) ? [block.source] : []),
      totalTokens,
      tokenBreakdown: [...framingBreakdown, ...contentBreakdown],
    };
  } catch (error) {
    return {
      ok: false,
      code: 'tokenizer_error',
      message: error instanceof Error ? error.message : 'Tokenizer failed while counting a prompt candidate.',
      totalTokens: 0,
      tokenBreakdown: failureBreakdown(),
    };
  }
}

export async function allocatePromptBudget<TBlock extends PromptBudgetBlock>(input: {
  maxTokens: number;
  blocks: readonly TBlock[];
  countTokens: (block: TBlock) => number | Promise<number>;
  fit?: 'inclusive' | 'strict';
}): Promise<PromptBudgetResult> {
  if (!validBudget(input.maxTokens)) {
    return {
      ok: false,
      code: 'invalid_budget',
      message: 'Prompt token budget must be a non-negative safe integer.',
      totalTokens: 0,
      tokenBreakdown: [],
    };
  }

  const counted: Array<CountedBlock<TBlock>> = [];
  try {
    for (const block of input.blocks) {
      const tokens = await input.countTokens(block);
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new TypeError(`Tokenizer returned an invalid count for ${block.source}`);
      }
      counted.push({ block, tokens });
    }
  } catch (error) {
    return {
      ok: false,
      code: 'tokenizer_error',
      message: error instanceof Error ? error.message : 'Tokenizer failed while counting a prompt block.',
      totalTokens: 0,
      tokenBreakdown: counted.map(({ block, tokens }) => ({
        source: block.source,
        includedTokens: 0,
        omittedTokens: tokens,
        reason: block.omitReason ?? 'context_overflow',
      })),
    };
  }

  const eligible = counted.filter(({ block }) => block.omitReason === undefined);
  const immutableTokens = eligible
    .filter(({ block }) => block.policy === 'immutable')
    .reduce((sum, item) => sum + item.tokens, 0);
  if (immutableTokens > input.maxTokens) {
    return {
      ok: false,
      code: 'context_overflow',
      message: 'Immutable prompt content exceeds the available context budget.',
      totalTokens: 0,
      tokenBreakdown: counted.map(({ block, tokens }) => ({
        source: block.source,
        includedTokens: 0,
        omittedTokens: tokens,
        reason: block.omitReason ?? 'context_overflow',
      })),
    };
  }

  const included = new Set<TBlock>();
  const fits = (tokens: number) => input.fit === 'strict'
    ? tokens < input.maxTokens
    : tokens <= input.maxTokens;
  let totalTokens = 0;
  for (const item of eligible) {
    if (item.block.policy !== 'immutable') continue;
    included.add(item.block);
    totalTokens += item.tokens;
  }

  let historyBlocked = false;
  const histories = eligible.filter(({ block }) => block.policy === 'history');
  for (let index = histories.length - 1; index >= 0; index -= 1) {
    const item = histories[index]!;
    if (!historyBlocked && fits(totalTokens + item.tokens)) {
      included.add(item.block);
      totalTokens += item.tokens;
    } else {
      historyBlocked = true;
    }
  }

  let optionalBlocked = false;
  for (const item of eligible.filter(({ block }) => block.policy === 'optional')) {
    if (!optionalBlocked && fits(totalTokens + item.tokens)) {
      included.add(item.block);
      totalTokens += item.tokens;
    } else {
      optionalBlocked = true;
    }
  }

  return {
    ok: true,
    includedBlockIndexes: counted.flatMap(({ block }, index) => included.has(block) ? [index] : []),
    includedSources: counted.filter(({ block }) => included.has(block)).map(({ block }) => block.source),
    totalTokens,
    tokenBreakdown: counted.map(({ block, tokens }) => included.has(block)
      ? { source: block.source, includedTokens: tokens, omittedTokens: 0 }
      : {
          source: block.source,
          includedTokens: 0,
          omittedTokens: tokens,
          reason: block.omitReason ?? (block.policy === 'history' ? 'history_budget' : 'optional_budget'),
        }),
  };
}
