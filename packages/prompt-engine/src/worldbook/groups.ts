import type {
  MatchedWorldbookEntry,
  PreparedWorldbookEntry,
  WorldbookEvaluationSettings,
  WorldbookExclusionReason,
} from './types.js';

function sourceUidKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

/** Final prompt and candidate order. Modern priority precedes legacy order. */
export function comparePreparedEntries(left: PreparedWorldbookEntry, right: PreparedWorldbookEntry): number {
  const leftPriority = left.entry.priority ?? Number.NEGATIVE_INFINITY;
  const rightPriority = right.entry.priority ?? Number.NEGATIVE_INFINITY;
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  if (left.entry.order !== right.entry.order) return right.entry.order - left.entry.order;
  if (left.bookIndex !== right.bookIndex) return left.bookIndex - right.bookIndex;
  const leftUid = sourceUidKey(left.entry.sourceUid);
  const rightUid = sourceUidKey(right.entry.sourceUid);
  if (leftUid !== rightUid) return leftUid < rightUid ? -1 : 1;
  if (left.entry.sourceOrdinal !== right.entry.sourceOrdinal) {
    return left.entry.sourceOrdinal - right.entry.sourceOrdinal;
  }
  if (left.entry.id !== right.entry.id) return left.entry.id < right.entry.id ? -1 : 1;
  return 0;
}

export function compareMatchedEntries(left: MatchedWorldbookEntry, right: MatchedWorldbookEntry): number {
  return comparePreparedEntries(left.prepared, right.prepared);
}

function hashSeed(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Mulberry32 is local, deterministic, and has no dependency on global random state. */
export function createWorldbookRandom(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function entryGroups(group: string): string[] {
  return group.split(/,\s*/).map((value) => value.trim()).filter((value) => value !== '');
}

export function filterWorldbookGroups(input: {
  candidates: readonly MatchedWorldbookEntry[];
  alreadyActiveGroups: ReadonlySet<string>;
  stickyEntryKeys: ReadonlySet<string>;
  settings: WorldbookEvaluationSettings;
  random: () => number;
  exclude: (entry: PreparedWorldbookEntry, reason: WorldbookExclusionReason) => void;
}): MatchedWorldbookEntry[] {
  const selected = new Set(input.candidates);
  const groupNames = [...new Set(input.candidates.flatMap((candidate) => entryGroups(candidate.prepared.entry.group)))];

  const remove = (candidate: MatchedWorldbookEntry, reason: WorldbookExclusionReason): void => {
    if (!selected.delete(candidate)) return;
    input.exclude(candidate.prepared, reason);
  };

  for (const groupName of groupNames) {
    let group = input.candidates
      .filter((candidate) => selected.has(candidate) && entryGroups(candidate.prepared.entry.group).includes(groupName))
      .sort(compareMatchedEntries);
    if (group.length === 0) continue;
    if (input.alreadyActiveGroups.has(groupName)) {
      for (const candidate of group) remove(candidate, 'group_already_active');
      continue;
    }

    const sticky = group.filter((candidate) => input.stickyEntryKeys.has(candidate.prepared.entryKey));
    if (sticky.length > 0) {
      for (const candidate of group) {
        if (!sticky.includes(candidate)) remove(candidate, 'group_loser');
      }
      continue;
    }

    const scoringEnabled = input.settings.useGroupScoring === true
      || group.some((candidate) => candidate.prepared.entry.useGroupScoring === true);
    if (scoringEnabled) {
      const maxScore = Math.max(...group.map((candidate) => candidate.score));
      for (const candidate of group) {
        const usesScoring = candidate.prepared.entry.useGroupScoring
          ?? input.settings.useGroupScoring
          ?? false;
        if (usesScoring && candidate.score < maxScore) remove(candidate, 'group_loser');
      }
      group = group.filter((candidate) => selected.has(candidate));
    }
    if (group.length <= 1) continue;

    const overrides = group.filter((candidate) => candidate.prepared.entry.groupOverride);
    if (overrides.length > 0) {
      const winner = overrides.sort(compareMatchedEntries)[0]!;
      for (const candidate of group) {
        if (candidate !== winner) remove(candidate, 'group_loser');
      }
      continue;
    }

    const weights = group.map((candidate) => Math.max(0, candidate.prepared.entry.groupWeight));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const roll = input.random() * totalWeight;
    let cumulative = 0;
    let winner = group[0]!;
    if (totalWeight > 0) {
      for (let index = 0; index < group.length; index += 1) {
        cumulative += weights[index]!;
        if (roll <= cumulative) {
          winner = group[index]!;
          break;
        }
      }
    }
    for (const candidate of group) {
      if (candidate !== winner) remove(candidate, 'group_loser');
    }
  }

  return input.candidates.filter((candidate) => selected.has(candidate)).sort(compareMatchedEntries);
}
