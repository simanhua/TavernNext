import { RE2JS } from 're2js';
import type { NormalizedWorldbookEntry } from '@tavernnext/st-compat';
import {
  MAX_WORLDBOOK_MATCH_OPERATIONS,
  MAX_WORLDBOOK_REGEX_CHARACTERS,
  MAX_WORLDBOOK_REGEX_PROGRAM_SIZE,
  type PreparedWorldbookEntry,
  type WorldbookEvaluationSettings,
  type WorldbookExclusionReason,
  type WorldbookScanSources,
  type WorldbookWarning,
} from './types.js';

const MATCHER = '\x01';
const JOINER = `\n${MATCHER}`;

export interface MatchOperationBudget {
  count: number;
}

export interface EntryMatchResult {
  matched: boolean;
  score: number;
  reason: Extract<
    WorldbookExclusionReason,
    'missing_keys' | 'primary_key_miss' | 'secondary_key_miss' | 'invalid_regex' | 'unsafe_regex'
  >;
}

interface KeyMatchResult {
  matched: boolean;
  issue?: 'invalid_regex' | 'unsafe_regex';
}

export class MatchOperationLimitError extends Error {
  constructor() {
    super('Worldbook keyword matching exceeded the safe operation limit.');
    this.name = 'MatchOperationLimitError';
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDelimitedRegex(value: string):
  | { kind: 'literal' }
  | { kind: 'invalid' }
  | { kind: 'unsafe' }
  | { kind: 'regex'; test: (value: string) => boolean } {
  if (!value.startsWith('/')) return { kind: 'literal' };
  const match = /^\/([\s\S]+?)\/([gimsuy]*)$/.exec(value);
  if (match === null) return { kind: 'invalid' };
  const pattern = match[1]!;
  const flags = match[2]!;
  if (pattern.length > MAX_WORLDBOOK_REGEX_CHARACTERS || /(^|[^\\])\//.test(pattern)) {
    return { kind: 'invalid' };
  }
  if (new Set(flags).size !== flags.length) return { kind: 'invalid' };
  const unescapedPattern = pattern.replaceAll('\\/', '/');
  if (hasUnsupportedRegexSyntax(unescapedPattern)) return { kind: 'unsafe' };
  try {
    let re2Flags = 0;
    if (flags.includes('i')) re2Flags |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes('m')) re2Flags |= RE2JS.MULTILINE;
    if (flags.includes('s')) re2Flags |= RE2JS.DOTALL;
    const regex = RE2JS.compile(RE2JS.translateRegExp(unescapedPattern), re2Flags);
    if (regex.programSize() > MAX_WORLDBOOK_REGEX_PROGRAM_SIZE) return { kind: 'unsafe' };
    const sticky = flags.includes('y');
    return {
      kind: 'regex',
      test: sticky
        ? (text) => regex.matcher(text).lookingAt()
        : (text) => regex.test(text),
    };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Reject JavaScript constructs outside RE2's linear-time language. This scans
 * syntax only; user patterns are never compiled or executed by native RegExp.
 */
function hasUnsupportedRegexSyntax(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      const escaped = pattern[index + 1];
      if ((escaped !== undefined && escaped >= '1' && escaped <= '9') || escaped === 'k') return true;
      index += 1;
      continue;
    }
    if (pattern[index] !== '(' || pattern[index + 1] !== '?') continue;
    const operator = pattern[index + 2];
    if (operator === '=' || operator === '!' || operator === '>' || operator === '(') return true;
    if (operator === '<' && (pattern[index + 3] === '=' || pattern[index + 3] === '!')) return true;
  }
  return false;
}

function matchKey(
  haystack: string,
  rawNeedle: string,
  entry: NormalizedWorldbookEntry,
  settings: WorldbookEvaluationSettings,
  operations: MatchOperationBudget,
): KeyMatchResult {
  operations.count += 1;
  if (operations.count > MAX_WORLDBOOK_MATCH_OPERATIONS) throw new MatchOperationLimitError();

  const needle = rawNeedle.trim();
  if (needle === '') return { matched: false };
  if (entry.useRegex) {
    const parsed = parseDelimitedRegex(needle);
    if (parsed.kind === 'invalid') return { matched: false, issue: 'invalid_regex' };
    if (parsed.kind === 'unsafe') return { matched: false, issue: 'unsafe_regex' };
    if (parsed.kind === 'regex') {
      return { matched: parsed.test(haystack) };
    }
  }

  const caseSensitive = entry.caseSensitive ?? settings.caseSensitive ?? false;
  const transformedHaystack = caseSensitive ? haystack : haystack.toLowerCase();
  const transformedNeedle = caseSensitive ? needle : needle.toLowerCase();
  const wholeWords = entry.matchWholeWords ?? settings.matchWholeWords ?? false;
  if (!wholeWords) return { matched: transformedHaystack.includes(transformedNeedle) };
  if (/\s/.test(transformedNeedle)) {
    return { matched: transformedHaystack.includes(transformedNeedle) };
  }
  return {
    matched: new RegExp(`(?:^|\\W)(${escapeRegex(transformedNeedle)})(?:$|\\W)`).test(transformedHaystack),
  };
}

function pushSelectedCardSources(parts: string[], entry: NormalizedWorldbookEntry, sources: WorldbookScanSources): void {
  if (entry.matchPersonaDescription && sources.persona?.description) parts.push(sources.persona.description);
  if (entry.matchCharacterDescription && sources.character?.description) parts.push(sources.character.description);
  if (entry.matchCharacterPersonality && sources.character?.personality) parts.push(sources.character.personality);
  if (entry.matchCharacterDepthPrompt && sources.character?.depthPrompt) parts.push(sources.character.depthPrompt);
  if (entry.matchScenario && sources.character?.scenario) parts.push(sources.character.scenario);
  if (entry.matchCreatorNotes && sources.character?.creatorNotes) parts.push(sources.character.creatorNotes);
}

/**
 * Locked scan order: newest-first messages, enabled Persona/card fields,
 * caller additional sources, then activation text from earlier recursion passes.
 */
export function buildWorldbookScanText(input: {
  prepared: PreparedWorldbookEntry;
  sources: WorldbookScanSources;
  settings: WorldbookEvaluationSettings;
  globalDepth: number;
  recursionText: readonly string[];
  includeRecursion: boolean;
}): string {
  const depth = input.prepared.entry.scanDepth
    ?? input.prepared.bookScanDepth
    ?? input.globalDepth;
  if (!Number.isFinite(depth) || depth <= 0) return '';
  const boundedDepth = Math.min(Math.floor(depth), input.sources.messages.length);
  const parts = input.sources.messages.slice(0, boundedDepth).map((value) => value.trim());
  pushSelectedCardSources(parts, input.prepared.entry, input.sources);
  for (const source of input.sources.additional) parts.push(source.content);
  if (input.includeRecursion) parts.push(...input.recursionText);
  return `${MATCHER}${parts.join(JOINER)}`;
}

export function matchWorldbookEntry(input: {
  prepared: PreparedWorldbookEntry;
  text: string;
  settings: WorldbookEvaluationSettings;
  operations: MatchOperationBudget;
  warn: (warning: WorldbookWarning) => void;
}): EntryMatchResult {
  const { entry } = input.prepared;
  if (entry.keys.length === 0) return { matched: false, score: 0, reason: 'missing_keys' };

  let primaryScore = 0;
  let primaryIssue: 'invalid_regex' | 'unsafe_regex' | undefined;
  entry.keys.forEach((key, keyIndex) => {
    const result = matchKey(input.text, key, entry, input.settings, input.operations);
    if (result.matched) primaryScore += 1;
    if (result.issue !== undefined) {
      primaryIssue ??= result.issue;
      input.warn({
        code: result.issue,
        message: result.issue === 'unsafe_regex'
          ? 'A potentially catastrophic Worldbook regex was rejected by the runtime safety guard.'
          : 'A malformed slash-delimited Worldbook regex was ignored.',
        entryKey: input.prepared.entryKey,
        bookId: input.prepared.bookId,
        keyIndex,
      });
    }
  });
  if (primaryScore === 0) {
    return { matched: false, score: 0, reason: primaryIssue ?? 'primary_key_miss' };
  }

  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return { matched: true, score: primaryScore, reason: 'primary_key_miss' };
  }

  let secondaryScore = 0;
  let secondaryIssue: 'invalid_regex' | 'unsafe_regex' | undefined;
  entry.secondaryKeys.forEach((key, secondaryIndex) => {
    const result = matchKey(input.text, key, entry, input.settings, input.operations);
    if (result.matched) secondaryScore += 1;
    if (result.issue !== undefined) {
      secondaryIssue ??= result.issue;
      input.warn({
        code: result.issue,
        message: result.issue === 'unsafe_regex'
          ? 'A potentially catastrophic Worldbook regex was rejected by the runtime safety guard.'
          : 'A malformed slash-delimited Worldbook regex was ignored.',
        entryKey: input.prepared.entryKey,
        bookId: input.prepared.bookId,
        keyIndex: entry.keys.length + secondaryIndex,
      });
    }
  });
  const any = secondaryScore > 0;
  const all = secondaryScore === entry.secondaryKeys.length;
  const matched = entry.selectiveLogic === 0 ? any
    : entry.selectiveLogic === 1 ? !all
      : entry.selectiveLogic === 2 ? !any
        : entry.selectiveLogic === 3 ? all
          : false;
  if (!matched) {
    return { matched: false, score: primaryScore, reason: secondaryIssue ?? 'secondary_key_miss' };
  }
  // Fail closed when negative logic would activate solely because an unsafe or
  // malformed secondary expression was treated as a non-match.
  if (secondaryIssue !== undefined && (entry.selectiveLogic === 1 || entry.selectiveLogic === 2)) {
    return { matched: false, score: primaryScore, reason: secondaryIssue };
  }
  const score = entry.selectiveLogic === 0 || entry.selectiveLogic === 3
    ? primaryScore + secondaryScore
    : primaryScore;
  return { matched: true, score, reason: 'secondary_key_miss' };
}
