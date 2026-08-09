import type {
  MatchedWorldbookEntry,
  WorldbookExclusionReason,
  WorldbookTokenCounter,
  WorldbookTokenUsage,
} from './types.js';

export interface WorldbookBudgetResult {
  selected: MatchedWorldbookEntry[];
  tokenUsageAfter: Map<string, number>;
  usage: WorldbookTokenUsage;
  tokenizerError: boolean;
}
function exactCount(tokenizer: WorldbookTokenCounter, text: string): number {
  const count = tokenizer.countText(text);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid Worldbook token count.');
  return count;
}

/**
 * Counts the exact joined candidate after every addition. The strict `<`
 * boundary intentionally matches SillyTavern 1.18 World Info rather than the
 * inclusive Chat prompt allocator.
 */
export function allocateWorldbookBudget(input: {
  candidates: readonly MatchedWorldbookEntry[];
  budget: number;
  tokenizer: WorldbookTokenCounter;
  exclude: (candidate: MatchedWorldbookEntry, reason: WorldbookExclusionReason) => void;
}): WorldbookBudgetResult {
  const selected: MatchedWorldbookEntry[] = [];
  const tokenUsageAfter = new Map<string, number>();
  let used = 0;
  let overflowed = false;
  try {
    for (const candidate of input.candidates) {
      if (overflowed && !candidate.prepared.entry.ignoreBudget) {
        input.exclude(candidate, 'budget');
        continue;
      }
      const text = [...selected, candidate].map((value) => value.prepared.entry.content).join('\n');
      const candidateTokens = exactCount(input.tokenizer, text);
      if (!candidate.prepared.entry.ignoreBudget && candidateTokens >= input.budget) {
        overflowed = true;
        input.exclude(candidate, 'budget');
        continue;
      }
      selected.push(candidate);
      used = candidateTokens;
      tokenUsageAfter.set(candidate.prepared.entryKey, candidateTokens);
    }
  } catch {
    for (const candidate of input.candidates) input.exclude(candidate, 'tokenizer_error');
    return {
      selected: [],
      tokenUsageAfter: new Map(),
      usage: { budget: input.budget, used: 0, overflowed: false },
      tokenizerError: true,
    };
  }
  return {
    selected,
    tokenUsageAfter,
    usage: { budget: input.budget, used, overflowed },
    tokenizerError: false,
  };
}
