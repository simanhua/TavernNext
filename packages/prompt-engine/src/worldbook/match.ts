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

// Plane 15 is reserved from assigned characters (private-use code points plus
// two terminal noncharacters), so none of these 65,536 runes case-fold. Original
// supplementary input cannot collide because non-u matching first decomposes it
// into its two UTF-16 surrogate code units.
const LEGACY_CODE_UNIT_TOKEN_BASE = 0xf0000;
const MAX_LEGACY_CLASS_RANGE_WORK = 65_536;

/**
 * ECMAScript's legacy (non-u) IgnoreCase Canonicalize operation works on one
 * UTF-16 code unit at a time. In particular, it keeps multi-code-unit uppercase
 * mappings and non-ASCII-to-ASCII mappings unchanged. RE2's case folding is
 * Unicode-aware, so those two rules must be enforced before RE2 sees input.
 */
function canonicalizeLegacyCodeUnit(codeUnit: number): number {
  const value = String.fromCharCode(codeUnit);
  const uppercase = value.toUpperCase();
  if (uppercase.length !== 1) return codeUnit;
  const canonical = uppercase.charCodeAt(0);
  if (codeUnit >= 0x80 && canonical < 0x80) return codeUnit;
  return canonical;
}

function legacyCodeUnitToken(codeUnit: number): string {
  return String.fromCodePoint(LEGACY_CODE_UNIT_TOKEN_BASE + codeUnit);
}

function legacyCodeUnitTokenEscape(codeUnit: number): string {
  return `\\x{${(LEGACY_CODE_UNIT_TOKEN_BASE + codeUnit).toString(16)}}`;
}

interface LegacyClassAtom {
  codeUnit?: number;
  source: string;
  nextIndex: number;
}

function readLegacyClassAtom(value: string, index: number): LegacyClassAtom | undefined {
  const current = value[index];
  if (current === undefined || current === ']') return undefined;
  if (current !== '\\') {
    return { codeUnit: current.charCodeAt(0), source: current, nextIndex: index + 1 };
  }
  const escaped = value[index + 1];
  if (escaped === undefined) return undefined;
  const unicodeEscape = /^\\u([0-9a-fA-F]{4})/.exec(value.slice(index));
  if (unicodeEscape !== null) {
    return {
      codeUnit: Number.parseInt(unicodeEscape[1]!, 16),
      source: unicodeEscape[0],
      nextIndex: index + unicodeEscape[0].length,
    };
  }
  const byteEscape = /^\\x([0-9a-fA-F]{2})/.exec(value.slice(index));
  if (byteEscape !== null) {
    return {
      codeUnit: Number.parseInt(byteEscape[1]!, 16),
      source: byteEscape[0],
      nextIndex: index + byteEscape[0].length,
    };
  }
  if ('dDsSwW'.includes(escaped)) {
    return { source: `\\${escaped}`, nextIndex: index + 2 };
  }
  const control = value[index + 2];
  if (escaped === 'c' && control !== undefined && /[A-Za-z]/.test(control)) {
    return {
      codeUnit: control.toUpperCase().charCodeAt(0) % 32,
      source: value.slice(index, index + 3),
      nextIndex: index + 3,
    };
  }
  const simpleEscapes: Readonly<Record<string, number>> = {
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  };
  const simple = simpleEscapes[escaped];
  if (simple !== undefined) return { codeUnit: simple, source: `\\${escaped}`, nextIndex: index + 2 };
  if (escaped === '0') {
    if (/[0-9]/.test(value[index + 2] ?? '')) return undefined;
    return { codeUnit: 0, source: '\\0', nextIndex: index + 2 };
  }
  return { codeUnit: escaped.charCodeAt(0), source: `\\${escaped}`, nextIndex: index + 2 };
}

function encodedLegacyCodeUnit(codeUnit: number): number {
  return codeUnit < 0x80 ? codeUnit : LEGACY_CODE_UNIT_TOKEN_BASE + codeUnit;
}

function renderEncodedRange(first: number, last: number): string {
  const start = `\\x{${encodedLegacyCodeUnit(first).toString(16)}}`;
  if (first === last) return start;
  return `${start}-\\x{${encodedLegacyCodeUnit(last).toString(16)}}`;
}

function renderLegacyClassSet(set: Uint8Array): string {
  let rendered = '';
  const appendRuns = (first: number, last: number): void => {
    for (let index = first; index <= last;) {
      if (set[index] === 0) {
        index += 1;
        continue;
      }
      let end = index;
      while (end < last && set[end + 1] === 1) end += 1;
      rendered += renderEncodedRange(index, end);
      index = end + 1;
    }
  };
  // Encoding jumps between ASCII and non-ASCII, so a range cannot cross 0x7f.
  appendRuns(0, 0x7f);
  appendRuns(0x80, 0xffff);
  return rendered;
}

function transformLegacyCharacterClass(
  value: string,
  openIndex: number,
  budget: { rangeWork: number },
): { source: string; endIndex: number } | undefined {
  let index = openIndex + 1;
  let negated = false;
  if (value[index] === '^') {
    negated = true;
    index += 1;
  }
  const set = new Uint8Array(65_536);
  const opaque: string[] = [];
  while (index < value.length && value[index] !== ']') {
    const first = readLegacyClassAtom(value, index);
    if (first === undefined) return undefined;
    if (value[first.nextIndex] === '-' && value[first.nextIndex + 1] !== ']') {
      const last = readLegacyClassAtom(value, first.nextIndex + 1);
      if (last === undefined || first.codeUnit === undefined || last.codeUnit === undefined) return undefined;
      if (last.codeUnit < first.codeUnit) return undefined;
      const rangeWork = last.codeUnit - first.codeUnit + 1;
      if (rangeWork > MAX_LEGACY_CLASS_RANGE_WORK - budget.rangeWork) return undefined;
      budget.rangeWork += rangeWork;
      for (let codeUnit = first.codeUnit; codeUnit <= last.codeUnit; codeUnit += 1) {
        set[canonicalizeLegacyCodeUnit(codeUnit)] = 1;
      }
      index = last.nextIndex;
      continue;
    }
    if (first.codeUnit === undefined) opaque.push(first.source);
    else set[canonicalizeLegacyCodeUnit(first.codeUnit)] = 1;
    index = first.nextIndex;
  }
  if (value[index] !== ']') return undefined;
  const contents = `${renderLegacyClassSet(set)}${opaque.join('')}`;
  if (contents === '') {
    return {
      source: negated ? '[\\s\\S]' : '[^\\s\\S]',
      endIndex: index,
    };
  }
  return { source: `[${negated ? '^' : ''}${contents}]`, endIndex: index };
}

function utf16CodeUnitText(value: string, ignoreCase: boolean): string {
  let transformed = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (ignoreCase && codeUnit >= 0x80) {
      transformed += legacyCodeUnitToken(canonicalizeLegacyCodeUnit(codeUnit));
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      transformed += legacyCodeUnitToken(codeUnit);
    } else {
      transformed += value[index];
    }
  }
  return transformed;
}

function utf16CodeUnitPattern(value: string, ignoreCase: boolean): string | undefined {
  let transformed = '';
  const budget = { rangeWork: 0 };
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (ignoreCase && value[index] === '[') {
      const characterClass = transformLegacyCharacterClass(value, index, budget);
      if (characterClass === undefined) return undefined;
      transformed += characterClass.source;
      index = characterClass.endIndex;
      continue;
    }
    if (ignoreCase && codeUnit >= 0x80) {
      transformed += legacyCodeUnitTokenEscape(canonicalizeLegacyCodeUnit(codeUnit));
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      transformed += legacyCodeUnitTokenEscape(codeUnit);
      continue;
    }
    if (value[index] === '\\') {
      const escapedCodeUnit = /^\\u([0-9a-fA-F]{4})/.exec(value.slice(index));
      if (escapedCodeUnit !== null) {
        const escapedValue = Number.parseInt(escapedCodeUnit[1]!, 16);
        if ((ignoreCase && escapedValue >= 0x80)
          || (escapedValue >= 0xd800 && escapedValue <= 0xdfff)) {
          const canonical = ignoreCase ? canonicalizeLegacyCodeUnit(escapedValue) : escapedValue;
          transformed += legacyCodeUnitTokenEscape(canonical);
          index += 5;
          continue;
        }
      }
      const escapedByte = /^\\x([0-9a-fA-F]{2})/.exec(value.slice(index));
      if (ignoreCase && escapedByte !== null) {
        const escapedValue = Number.parseInt(escapedByte[1]!, 16);
        if (escapedValue >= 0x80) {
          transformed += legacyCodeUnitTokenEscape(canonicalizeLegacyCodeUnit(escapedValue));
          index += 3;
          continue;
        }
      }
      transformed += value[index];
      if (value[index + 1] !== undefined) {
        transformed += value[index + 1];
        index += 1;
      }
      continue;
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
  const ignoreCase = flags.includes('i');
  if (hasUnsupportedRegexSyntax(nativeRegex.source, unicode)) return finish({ kind: 'unsafe' });
  try {
    let re2Flags = 0;
    if (flags.includes('i')) re2Flags |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes('m')) re2Flags |= RE2JS.MULTILINE;
    if (flags.includes('s')) re2Flags |= RE2JS.DOTALL;
    const legacyPattern = unicode ? undefined : utf16CodeUnitPattern(nativeRegex.source, ignoreCase);
    if (!unicode && legacyPattern === undefined) return finish({ kind: 'unsafe' });
    const safePattern = unicode
      ? RE2JS.translateRegExp(nativeRegex)
      : RE2JS.translateRegExp(legacyPattern!);
    const regex = RE2JS.compile(safePattern, re2Flags);
    if (regex.programSize() > MAX_WORLDBOOK_REGEX_PROGRAM_SIZE) return finish({ kind: 'unsafe' });
    const sticky = flags.includes('y');
    return finish({
      kind: 'regex',
      test: sticky
        ? (text) => regex.matcher(unicode ? text : utf16CodeUnitText(text, ignoreCase)).lookingAt()
        : (text) => regex.test(unicode ? text : utf16CodeUnitText(text, ignoreCase)),
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
