import { RE2JS } from 're2js';
import type { NormalizedWorldbookEntry } from '@tavernnext/st-compat';
import {
  MAX_WORLDBOOK_MATCH_OPERATIONS,
  MAX_WORLDBOOK_MATCH_WORK_CHARACTERS,
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
  workCharacters: number;
  regexCache: Map<string, ParsedDelimitedRegex>;
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

type ParsedDelimitedRegex =
  | { kind: 'literal' }
  | { kind: 'invalid' }
  | { kind: 'unsafe' }
  | { kind: 'regex'; test: (value: string) => boolean };

export class MatchOperationLimitError extends Error {
  constructor() {
    super('Worldbook keyword matching exceeded the safe operation limit.');
    this.name = 'MatchOperationLimitError';
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SURROGATE_TOKEN_BASE = 0xf0000;

function utf16CodeUnitText(value: string): string {
  let transformed = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    transformed += codeUnit >= 0xd800 && codeUnit <= 0xdfff
      ? String.fromCodePoint(SURROGATE_TOKEN_BASE + codeUnit - 0xd800)
      : value[index];
  }
  return transformed;
}

function utf16CodeUnitPattern(value: string): string {
  let transformed = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      transformed += `\\x{${(SURROGATE_TOKEN_BASE + codeUnit - 0xd800).toString(16)}}`;
      continue;
    }
    if (value[index] === '\\' && value[index + 1] === 'u') {
      const escapedCodeUnit = /^\\u([0-9a-fA-F]{4})/.exec(value.slice(index));
      if (escapedCodeUnit !== null) {
        const escapedValue = Number.parseInt(escapedCodeUnit[1]!, 16);
        if (escapedValue >= 0xd800 && escapedValue <= 0xdfff) {
          transformed += `\\x{${(SURROGATE_TOKEN_BASE + escapedValue - 0xd800).toString(16)}}`;
          index += 5;
          continue;
        }
      }
    }
    transformed += value[index];
  }
  return transformed;
}

function parseDelimitedRegex(value: string, cache: Map<string, ParsedDelimitedRegex>): ParsedDelimitedRegex {
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const finish = (parsed: ParsedDelimitedRegex): ParsedDelimitedRegex => {
    cache.set(value, parsed);
    return parsed;
  };
  if (!value.startsWith('/')) return finish({ kind: 'literal' });
  const match = /^\/([\s\S]+?)\/([dgimsvuy]*)$/.exec(value);
  if (match === null) return finish({ kind: 'invalid' });
  const pattern = match[1]!;
  const flags = match[2]!;
  if (pattern.length > MAX_WORLDBOOK_REGEX_CHARACTERS || /(^|[^\\])\//.test(pattern)) {
    return finish({ kind: 'invalid' });
  }
  if (new Set(flags).size !== flags.length) return finish({ kind: 'invalid' });
  const unescapedPattern = pattern.replaceAll('\\/', '/');
  let nativeRegex: RegExp;
  try {
    // Syntax validation only. User expressions are never executed by native RegExp.
    nativeRegex = new RegExp(unescapedPattern, flags);
  } catch {
    return finish({ kind: 'invalid' });
  }
  if (flags.includes('v')) return finish({ kind: 'unsafe' });
  const unicode = flags.includes('u');
  if (hasUnsupportedRegexSyntax(nativeRegex.source, unicode)) return finish({ kind: 'unsafe' });
  try {
    let re2Flags = 0;
    if (flags.includes('i')) re2Flags |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes('m')) re2Flags |= RE2JS.MULTILINE;
    if (flags.includes('s')) re2Flags |= RE2JS.DOTALL;
    const safePattern = unicode
      ? RE2JS.translateRegExp(nativeRegex)
      : RE2JS.translateRegExp(utf16CodeUnitPattern(nativeRegex.source));
    const regex = RE2JS.compile(safePattern, re2Flags);
    if (regex.programSize() > MAX_WORLDBOOK_REGEX_PROGRAM_SIZE) return finish({ kind: 'unsafe' });
    const sticky = flags.includes('y');
    return finish({
      kind: 'regex',
      test: sticky
        ? (text) => regex.matcher(unicode ? text : utf16CodeUnitText(text)).lookingAt()
        : (text) => regex.test(unicode ? text : utf16CodeUnitText(text)),
    });
  } catch {
    return finish({ kind: 'invalid' });
  }
}

/**
 * Reject JavaScript constructs outside RE2's linear-time language. Native
 * RegExp is used only for bounded syntax compilation; it never sees scan text.
 */
function hasUnsupportedRegexSyntax(pattern: string, unicode: boolean): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      const escaped = pattern[index + 1];
      if ((escaped !== undefined && escaped >= '1' && escaped <= '9')
        || escaped === 'k'
        || escaped === 'Q'
        || escaped === 'E'
        || (!unicode && (escaped === 'p' || escaped === 'P') && pattern[index + 2] === '{')
        || (!unicode && escaped === 'u' && pattern[index + 2] === '{')) return true;
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

  const caseSensitive = entry.caseSensitive ?? settings.caseSensitive ?? false;
  const workMultiplier = !entry.useRegex && !caseSensitive ? 2 : 1;
  const work = workMultiplier * (haystack.length + rawNeedle.length);
  if (work > MAX_WORLDBOOK_MATCH_WORK_CHARACTERS - operations.workCharacters) {
    throw new MatchOperationLimitError();
  }
  operations.workCharacters += work;
  const needle = rawNeedle.trim();
  if (needle === '') return { matched: false };
  if (entry.useRegex) {
    const parsed = parseDelimitedRegex(needle, operations.regexCache);
    if (parsed.kind === 'invalid') return { matched: false, issue: 'invalid_regex' };
    if (parsed.kind === 'unsafe') return { matched: false, issue: 'unsafe_regex' };
    if (parsed.kind === 'regex') {
      return { matched: parsed.test(haystack) };
    }
  }

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
