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
  code: Extract<PromptCompilationErrorCode, 'invalid_budget' | 'tokenizer_error' | 'context_overflow'>;
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

  const standaloneTokens: number[] = [];
  const count = async (blocks: readonly TBlock[], source: string): Promise<number> => {
    const tokens = await input.countSelection(blocks);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new TypeError(`Tokenizer returned an invalid count for ${source}`);
    }
    return tokens;
  };
  const failureBreakdown = (reason: TokenOmissionReason = 'context_overflow'): TokenBreakdownEntry[] => standaloneTokens
    .map((tokens, index) => ({
      source: input.blocks[index]!.source,
      includedTokens: 0,
      omittedTokens: tokens,
      reason: input.blocks[index]!.omitReason ?? reason,
    }));

  try {
    for (const block of input.blocks) {
      standaloneTokens.push(await count([block], block.source));
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

  const eligibleIndexes = input.blocks.flatMap((block, index) => block.omitReason === undefined ? [index] : []);
  const selected = new Set(eligibleIndexes.filter((index) => input.blocks[index]!.policy === 'immutable'));
  const selectedBlocks = () => input.blocks.filter((_block, index) => selected.has(index));
  const fits = (tokens: number) => input.fit === 'strict'
    ? tokens < input.maxTokens
    : tokens <= input.maxTokens;
  let totalTokens: number;
  try {
    totalTokens = await count(selectedBlocks(), 'immutable prompt content');
  } catch (error) {
    return {
      ok: false,
      code: 'tokenizer_error',
      message: error instanceof Error ? error.message : 'Tokenizer failed while counting immutable prompt content.',
      totalTokens: 0,
      tokenBreakdown: failureBreakdown(),
    };
  }
  if (totalTokens > input.maxTokens) {
    return {
      ok: false,
      code: 'context_overflow',
      message: 'Immutable prompt content exceeds the available context budget.',
      totalTokens: 0,
      tokenBreakdown: failureBreakdown(),
    };
  }

  try {
    let historyBlocked = false;
    const historyIndexes = eligibleIndexes.filter((index) => input.blocks[index]!.policy === 'history');
    for (let position = historyIndexes.length - 1; position >= 0; position -= 1) {
      const index = historyIndexes[position]!;
      if (historyBlocked) continue;
      selected.add(index);
      const candidateTokens = await count(selectedBlocks(), input.blocks[index]!.source);
      if (fits(candidateTokens)) {
        totalTokens = candidateTokens;
      } else {
        selected.delete(index);
        historyBlocked = true;
      }
    }

    let optionalBlocked = false;
    for (const index of eligibleIndexes.filter((candidate) => input.blocks[candidate]!.policy === 'optional')) {
      if (optionalBlocked) continue;
      selected.add(index);
      const candidateTokens = await count(selectedBlocks(), input.blocks[index]!.source);
      if (fits(candidateTokens)) {
        totalTokens = candidateTokens;
      } else {
        selected.delete(index);
        optionalBlocked = true;
      }
    }

    const includedTokens = new Map<number, number>();
    const selectedIndexes = input.blocks.flatMap((_block, index) => selected.has(index) ? [index] : []);
    let attributedTokens = 0;
    for (const index of selectedIndexes) {
      const without = input.blocks.filter((_block, candidate) => selected.has(candidate) && candidate !== index);
      const withoutTokens = await count(without, input.blocks[index]!.source);
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
      const candidateTokens = await count(candidate, input.blocks[index]!.source);
      omittedTokens.set(index, Math.max(0, candidateTokens - totalTokens));
    }

    return {
      ok: true,
      includedBlockIndexes: input.blocks.flatMap((_block, index) => selected.has(index) ? [index] : []),
      includedSources: input.blocks.flatMap((block, index) => selected.has(index) ? [block.source] : []),
      totalTokens,
      tokenBreakdown: input.blocks.map((block, index) => selected.has(index)
        ? { source: block.source, includedTokens: includedTokens.get(index) ?? 0, omittedTokens: 0 }
        : {
            source: block.source,
            includedTokens: 0,
            omittedTokens: omittedTokens.get(index) ?? standaloneTokens[index]!,
            reason: block.omitReason ?? (block.policy === 'history' ? 'history_budget' : 'optional_budget'),
          }),
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
