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
 * Mirrors ST's accumulator calls: tokenize the empty baseline once, append a
 * trailing newline before each decision, and never tokenize an ignoreBudget
 * candidate. The strict `<` boundary differs from the Chat prompt allocator.
 */
export function allocateWorldbookBudget(input: {
  candidates: readonly MatchedWorldbookEntry[];
  budget: number;
  tokenizer: WorldbookTokenCounter;
  exclude: (candidate: MatchedWorldbookEntry, reason: WorldbookExclusionReason) => void;
}): WorldbookBudgetResult {
  const selected: MatchedWorldbookEntry[] = [];
  const tokenUsageAfter = new Map<string, number>();
  let newContent = '';
  let used = 0;
  let baselineTokens = 0;
  let overflowed = false;
  let remainingIgnoreBudget = input.candidates.filter((candidate) => candidate.prepared.entry.ignoreBudget).length;
  try {
    baselineTokens = exactCount(input.tokenizer, '');
    used = baselineTokens;
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index]!;
      if (candidate.prepared.entry.ignoreBudget) remainingIgnoreBudget -= 1;
      if (overflowed && !candidate.prepared.entry.ignoreBudget) {
        input.exclude(candidate, 'budget');
        if (remainingIgnoreBudget === 0) {
          for (const remainder of input.candidates.slice(index + 1)) input.exclude(remainder, 'budget');
          break;
        }
        continue;
      }
      newContent += `${candidate.prepared.entry.content}\n`;
      if (!candidate.prepared.entry.ignoreBudget) {
        const candidateTokens = baselineTokens + exactCount(input.tokenizer, newContent);
        if (candidateTokens >= input.budget) {
          overflowed = true;
          input.exclude(candidate, 'budget');
          continue;
        }
        used = candidateTokens;
      }
      selected.push(candidate);
      tokenUsageAfter.set(candidate.prepared.entryKey, used);
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
