import { describe, expect, it, vi } from 'vitest';
import { RE2JS } from 're2js';
import {
  evaluateWorldbooks,
  matchWorldbookEntry,
  type MatchOperationBudget,
  type PreparedWorldbookEntry,
} from '../../src/index.js';
import { evaluationInput, runtimeBook, worldbookEntry } from './fixtures.js';

function activatedUids(result: ReturnType<typeof evaluateWorldbooks>): Array<string | number> {
  return result.activated.map((entry) => entry.sourceUid);
}

function excludedReason(result: ReturnType<typeof evaluateWorldbooks>, uid: string | number): string | undefined {
  return result.excluded.find((entry) => entry.sourceUid === uid)?.reason;
}

function preparedMatcherEntry(
  uid: string,
  key: string,
): PreparedWorldbookEntry {
  return {
    entryKey: `test:${uid}`,
    fingerprint: `test:${uid}`,
    bookId: 'matcher-test',
    bookName: 'matcher-test',
    bookIndex: 0,
    entryIndex: 0,
    bookScanDepth: null,
    entry: worldbookEntry(uid, { keys: [key] }),
  };
}

function matcherOperations(): MatchOperationBudget {
  return {
    count: 0,
    workCharacters: 0,
    regexCache: new Map(),
    legacyTransformWork: 0,
  };
}

describe('Worldbook keyword matching', () => {
  it('matches literal and slash-delimited regex primary keys without leaking case or whole-word settings', () => {
    const entries = [
      worldbookEntry('literal', { keys: ['dragon'], content: 'literal' }),
      worldbookEntry('regex', { keys: ['/dr.gon/i'], content: 'regex' }),
      worldbookEntry('case-miss', { keys: ['Dragon'], caseSensitive: true }),
      worldbookEntry('whole-miss', { keys: ['cat'], matchWholeWords: true }),
      worldbookEntry('regex-as-literal', { keys: ['/dr.gon/i'], useRegex: false }),
    ];
    const result = evaluateWorldbooks(evaluationInput(
      [runtimeBook('matching', entries)],
      { scanSources: { messages: ['a dragon and concatenate'], additional: [], trigger: 'normal' } },
    ));

    expect(activatedUids(result)).toEqual(['literal', 'regex']);
    expect(excludedReason(result, 'case-miss')).toBe('primary_key_miss');
    expect(excludedReason(result, 'whole-miss')).toBe('primary_key_miss');
    expect(excludedReason(result, 'regex-as-literal')).toBe('primary_key_miss');
  });

  it('uses ST whole-word punctuation boundaries and global matching defaults', () => {
    const result = evaluateWorldbooks(evaluationInput(
      [runtimeBook('whole', [
        worldbookEntry('cat', { keys: ['cat'] }),
        worldbookEntry('upper', { keys: ['DRAGON'] }),
      ])],
      {
        scanSources: { messages: ['A cat! met a dragon.'], additional: [], trigger: 'normal' },
        settings: { matchWholeWords: true, caseSensitive: false },
      },
    ));
    expect(activatedUids(result)).toEqual(['cat', 'upper']);
  });

  it.each([
    { logic: 0, message: 'alpha beta', active: true, label: 'AND ANY' },
    { logic: 0, message: 'alpha', active: false, label: 'AND ANY miss' },
    { logic: 3, message: 'alpha beta gamma', active: true, label: 'AND ALL' },
    { logic: 3, message: 'alpha beta', active: false, label: 'AND ALL miss' },
    { logic: 2, message: 'alpha', active: true, label: 'NOT ANY' },
    { logic: 2, message: 'alpha beta', active: false, label: 'NOT ANY miss' },
    { logic: 1, message: 'alpha beta', active: true, label: 'NOT ALL' },
    { logic: 1, message: 'alpha beta gamma', active: false, label: 'NOT ALL miss' },
  ])('implements $label secondary-key logic', ({ logic, message, active }) => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('secondary', [worldbookEntry('logic', {
        keys: ['alpha'],
        secondaryKeys: ['beta', 'gamma'],
        selective: true,
        selectiveLogic: logic,
      })]),
    ], { scanSources: { messages: [message], additional: [], trigger: 'normal' } }));

    expect(activatedUids(result)).toEqual(active ? ['logic'] : []);
    if (!active) expect(excludedReason(result, 'logic')).toBe('secondary_key_miss');
  });

  it('scans additional sources and only the character/persona fields enabled by each entry', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('sources', [
        worldbookEntry('additional', { keys: ['extension sigil'] }),
        worldbookEntry('character', { keys: ['clockwork'], matchCharacterDescription: true }),
        worldbookEntry('persona', { keys: ['archivist'], matchPersonaDescription: true }),
        worldbookEntry('hidden', { keys: ['creator secret'], matchCreatorNotes: false }),
      ]),
    ], {
      scanSources: {
        messages: ['ordinary chat'],
        additional: [{ id: 'authors-note', content: 'extension sigil' }],
        trigger: 'normal',
        character: {
          name: 'Aster.png', tags: ['hero'], description: 'clockwork guardian',
          personality: '', depthPrompt: '', scenario: '', creatorNotes: 'creator secret',
        },
        persona: { name: 'Archivist', tags: ['scholar'], description: 'archivist persona' },
      },
    }));

    expect(activatedUids(result)).toEqual(['additional', 'character', 'persona']);
    expect(excludedReason(result, 'hidden')).toBe('primary_key_miss');
  });

  it('handles constants, disabled entries, trigger filters, and character/persona include/exclude filters', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('filters', [
        worldbookEntry('constant', { constant: true }),
        worldbookEntry('disabled', { constant: true, enabled: false }),
        worldbookEntry('trigger', { constant: true, triggers: ['continue'] }),
        worldbookEntry('character-include', {
          constant: true,
          characterFilter: { isExclude: false, names: ['Aster.png'], tags: ['hero'] },
        }),
        worldbookEntry('character-exclude', {
          constant: true,
          characterFilter: { isExclude: true, names: ['Aster.png'], tags: [] },
        }),
        worldbookEntry('persona-include', {
          constant: true,
          personaFilter: { isExclude: false, names: ['Archivist'], tags: ['scholar'] },
        }),
        worldbookEntry('persona-exclude', {
          constant: true,
          personaFilter: { isExclude: true, names: [], tags: ['scholar'] },
        }),
      ]),
    ], {
      scanSources: {
        messages: [], additional: [], trigger: 'normal',
        character: {
          name: 'Aster.png', tags: ['hero'], description: '', personality: '',
          depthPrompt: '', scenario: '', creatorNotes: '',
        },
        persona: { name: 'Archivist', tags: ['scholar'], description: '' },
      },
    }));

    expect(activatedUids(result)).toEqual(['character-include', 'constant', 'persona-include']);
    expect(excludedReason(result, 'disabled')).toBe('entry_disabled');
    expect(excludedReason(result, 'trigger')).toBe('trigger_mismatch');
    expect(excludedReason(result, 'character-exclude')).toBe('character_filter');
    expect(excludedReason(result, 'persona-exclude')).toBe('persona_filter');
  });

  it('warns on invalid and unsupported regexes while valid entries continue', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('regex-safety', [
        worldbookEntry('invalid', { keys: ['/[a-/'] }),
        worldbookEntry('linear-nested', { keys: ['/^(a+)+$/'] }),
        worldbookEntry('unsupported', { keys: ['/^(a+)\\1$/'] }),
        worldbookEntry('valid', { keys: ['safe'], content: 'valid' }),
      ]),
    ], { scanSources: { messages: [`${'a'.repeat(20_000)}! safe`], additional: [], trigger: 'normal' } }));

    expect(activatedUids(result)).toEqual(['valid']);
    expect(excludedReason(result, 'invalid')).toBe('invalid_regex');
    expect(excludedReason(result, 'linear-nested')).toBe('primary_key_miss');
    expect(excludedReason(result, 'unsupported')).toBe('unsafe_regex');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['invalid_regex', 'unsafe_regex']);
  });

  it('never executes overlapping-alternative user patterns through native RegExp.test', () => {
    const originalTest = RegExp.prototype.test;
    const nativeTest = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function guardedNativeTest(
      this: RegExp,
      value: string,
    ) {
      if (this.source === '(a|aa)+$') throw new Error('catastrophic user regex reached native execution');
      return originalTest.call(this, value);
    });
    try {
      const result = evaluateWorldbooks(evaluationInput([
        runtimeBook('linear-regex', [
          worldbookEntry('adversarial', { keys: ['/(a|aa)+$/'] }),
          worldbookEntry('sibling', { keys: ['safe'], content: 'safe' }),
        ]),
      ], {
        scanSources: {
          messages: [`${'a'.repeat(100_000)}! safe`], additional: [], trigger: 'normal',
        },
      }));

      expect(activatedUids(result)).toEqual(['sibling']);
      expect(excludedReason(result, 'adversarial')).toBe('primary_key_miss');
    } finally {
      nativeTest.mockRestore();
    }
  });

  it('accepts only JavaScript regex syntax before compiling the safe RE2 subset', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('regex-dialect', [
        worldbookEntry('re2-inline-flags', { keys: ['/(?i)a/'] }),
        worldbookEntry('re2-quote', { keys: ['/\\Qsafe\\E/'], sourceOrdinal: 1 }),
        worldbookEntry('valid', { keys: ['/safe/'], sourceOrdinal: 2 }),
        worldbookEntry('has-indices', { keys: ['/safe/d'], sourceOrdinal: 3 }),
        worldbookEntry('unicode-sets', { keys: ['/[a&&a]/v'], sourceOrdinal: 4 }),
      ]),
    ], { scanSources: { messages: ['safe a'], additional: [], trigger: 'normal' } }));

    expect(new Set(activatedUids(result))).toEqual(new Set(['valid', 'has-indices']));
    expect(excludedReason(result, 're2-inline-flags')).toBe('invalid_regex');
    expect(excludedReason(result, 're2-quote')).toBe('unsafe_regex');
    expect(excludedReason(result, 'unicode-sets')).toBe('unsafe_regex');
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'invalid_regex', 'unsafe_regex', 'unsafe_regex',
    ]);
  });

  it('preserves native UTF-16 dot semantics without u and code-point semantics with u', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('regex-unicode', [
        worldbookEntry('utf16', { keys: ['/^\\x01.$/'] }),
        worldbookEntry('unicode', { keys: ['/^\\x01.$/u'], sourceOrdinal: 1 }),
        worldbookEntry('two-code-units', { keys: ['/^\\x01..$/'], sourceOrdinal: 2 }),
        worldbookEntry('raw-astral', { keys: [`/${emoji}/`], sourceOrdinal: 3 }),
        worldbookEntry('escaped-surrogates', { keys: ['/\\uD83D\\uDE00/'], sourceOrdinal: 4 }),
      ]),
    ], { scanSources: { messages: [emoji], additional: [], trigger: 'normal' } }));

    expect(new Set(activatedUids(result))).toEqual(new Set([
      'unicode', 'two-code-units', 'raw-astral', 'escaped-surrogates',
    ]));
    expect(excludedReason(result, 'utf16')).toBe('primary_key_miss');
  });

  it.each([
    { label: 'Kelvin sign', pattern: '^\\x01k$', input: '\u212a', legacy: false, unicode: true },
    { label: 'long s', pattern: '^\\x01s$', input: '\u017f', legacy: false, unicode: true },
    { label: 'sharp s', pattern: '^\\x01ß$', input: '\u1e9e', legacy: false, unicode: true },
    { label: 'Greek theta symbol', pattern: '^\\x01θ$', input: '\u03f4', legacy: false, unicode: true },
    { label: 'Ohm sign', pattern: '^\\x01ω$', input: '\u2126', legacy: false, unicode: true },
    { label: 'Angstrom sign', pattern: '^\\x01å$', input: '\u212b', legacy: false, unicode: true },
    { label: 'dotless i', pattern: '^\\x01i$', input: '\u0131', legacy: false, unicode: false },
    { label: 'ASCII class', pattern: '^\\x01[k]$', input: '\u212a', legacy: false, unicode: true },
    { label: 'mixed canonical range', pattern: '^\\x01[À-ö]$', input: '×', legacy: true, unicode: true },
    { label: 'ASCII case pair', pattern: '^\\x01k$', input: 'K', legacy: true, unicode: true },
    { label: 'Latin accent', pattern: '^\\x01é$', input: 'É', legacy: true, unicode: true },
    { label: 'hex-escaped Latin accent', pattern: '^\\x01\\xE9$', input: 'É', legacy: true, unicode: true },
    { label: 'Unicode-escaped Latin accent', pattern: '^\\x01\\u00E9$', input: 'É', legacy: true, unicode: true },
    { label: 'Greek final sigma', pattern: '^\\x01σ$', input: 'ς', legacy: true, unicode: true },
  ])('implements complete ECMAScript legacy non-u folding for $label', ({ pattern, input, legacy, unicode }) => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('legacy-case-fold', [
        worldbookEntry('legacy', { keys: [`/${pattern}/i`] }),
        worldbookEntry('unicode', { keys: [`/${pattern}/iu`], sourceOrdinal: 1 }),
      ]),
    ], { scanSources: { messages: [input], additional: [], trigger: 'normal' } }));

    expect(activatedUids(result).includes('legacy')).toBe(legacy);
    expect(activatedUids(result).includes('unicode')).toBe(unicode);
  });

  it.each([
    { escape: '\\c0', target: 0x10 },
    { escape: '\\c9', target: 0x19 },
    { escape: '\\c_', target: 0x1f },
  ])('matches native legacy character-class semantics for $escape', ({ escape, target }) => {
    const native = new RegExp(`^[${escape}]$`, 'i');
    const targetCharacter = String.fromCharCode(target);
    expect(native.test(targetCharacter)).toBe(true);
    expect(native.test('c')).toBe(false);

    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('legacy-class-control', [
        worldbookEntry('target', { keys: [`/^\\x01[${escape}]$/i`] }),
      ]),
    ], { scanSources: { messages: [targetCharacter], additional: [], trigger: 'normal' } }));
    const literalResult = evaluateWorldbooks(evaluationInput([
      runtimeBook('legacy-class-control-literal', [
        worldbookEntry('literal-c', { keys: [`/^\\x01[${escape}]$/i`] }),
      ]),
    ], { scanSources: { messages: ['c'], additional: [], trigger: 'normal' } }));

    expect(activatedUids(result)).toEqual(['target']);
    expect(activatedUids(literalResult)).toEqual([]);
  });

  it('agrees with native legacy matching for a mixed class across every UTF-16 code unit', () => {
    const prepared = preparedMatcherEntry('full-domain-differential', '/^\\x01[À-ö]$/i');
    const operations = matcherOperations();
    const native = /^[À-ö]$/i;
    const mismatches: number[] = [];

    for (let codeUnit = 0; codeUnit <= 0xffff; codeUnit += 1) {
      const character = String.fromCharCode(codeUnit);
      const actual = matchWorldbookEntry({
        prepared,
        text: `\x01${character}`,
        settings: {},
        operations,
        warn: () => undefined,
      }).matched;
      if (actual !== native.test(character)) mismatches.push(codeUnit);
    }

    expect(mismatches).toEqual([]);
  }, 20_000);

  it('keeps the internal UTF-16 alphabet outside Unicode case-folding orbits', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('legacy-token-alphabet', [
        // With an internal base of U+10000 these become the case-paired
        // Deseret runes U+10400 and U+10428 even though the source Cyrillic
        // code units are unrelated under both JavaScript modes.
        worldbookEntry('legacy', { keys: ['/^\\x01\\u0400$/i'] }),
        worldbookEntry('unicode', { keys: ['/^\\x01\\u0400$/iu'], sourceOrdinal: 1 }),
      ]),
    ], { scanSources: { messages: ['\u0428'], additional: [], trigger: 'normal' } }));

    expect(activatedUids(result)).toEqual([]);
  });

  it('bounds cumulative legacy character-class canonicalization work', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('legacy-class-cap', [
        worldbookEntry('oversized', { keys: ['/[\\u0000-\\uffff][\\u0000-\\uffff]/i'] }),
        worldbookEntry('valid', { keys: ['/safe/i'], sourceOrdinal: 1 }),
      ]),
    ], { scanSources: { messages: ['safe'], additional: [], trigger: 'normal' } }));

    expect(activatedUids(result)).toEqual(['valid']);
    expect(excludedReason(result, 'oversized')).toBe('unsafe_regex');
    expect(result.warnings.map((warning) => warning.code)).toContain('unsafe_regex');
  });

  it('transforms many singleton classes without full-domain work per class', () => {
    const singletonCount = 330;
    const key = `/^\\x01${'[a]'.repeat(singletonCount)}$/i`;
    const prepared = preparedMatcherEntry('singleton-classes', key);
    const operations = matcherOperations();
    const NativeUint8Array = globalThis.Uint8Array;
    let fullDomainAllocations = 0;
    const TrackingUint8Array = new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === 65_536) fullDomainAllocations += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    vi.stubGlobal('Uint8Array', TrackingUint8Array);
    try {
      const result = matchWorldbookEntry({
        prepared,
        text: `\x01${'a'.repeat(singletonCount)}`,
        settings: {},
        operations,
        warn: () => undefined,
      });

      expect(result.matched).toBe(true);
      expect(fullDomainAllocations).toBe(0);
      expect(operations.legacyTransformWork).toBeGreaterThan(0);
      expect(operations.legacyTransformWork).toBeLessThan(10_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects an expanded legacy source before invoking the RE2 compiler', () => {
    const key = `/^\\x01[\\u0000-\\uffff]${'é'.repeat(1_000)}$/i`;
    const prepared = preparedMatcherEntry('expanded-source-cap', key);
    const operations = matcherOperations();
    const compile = vi.spyOn(RE2JS, 'compile');
    try {
      const result = matchWorldbookEntry({
        prepared,
        text: '\x01safe',
        settings: {},
        operations,
        warn: () => undefined,
      });

      expect(result).toMatchObject({ matched: false, reason: 'unsafe_regex' });
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });

  it('compiles each slash-delimited regex once per evaluation', () => {
    const compile = vi.spyOn(RE2JS, 'compile');
    try {
      const input = evaluationInput([
        runtimeBook('regex-cache', [
          worldbookEntry('first', { keys: ['/shared/'] }),
          worldbookEntry('second', { keys: ['/shared/'], sourceOrdinal: 1 }),
        ]),
      ], { scanSources: { messages: ['shared'], additional: [], trigger: 'normal' } });

      expect(activatedUids(evaluateWorldbooks(input))).toEqual(['first', 'second']);
      expect(compile.mock.calls.filter(([pattern]) => pattern === 'shared')).toHaveLength(1);

      evaluateWorldbooks(input);
      expect(compile.mock.calls.filter(([pattern]) => pattern === 'shared')).toHaveLength(2);
    } finally {
      compile.mockRestore();
    }
  });

  it('caps cumulative character matching work before scanning every maximum-sized haystack', () => {
    const hugeMessage = 'x'.repeat(2 * 1024 * 1024 - 128);
    const entries = Array.from({ length: 12 }, (_, index) => worldbookEntry(`miss-${index}`, {
      keys: [`needle-${index}`],
      caseSensitive: true,
      sourceOrdinal: index,
    }));
    const originalIncludes = String.prototype.includes;
    let hugeScans = 0;
    const includes = vi.spyOn(String.prototype, 'includes').mockImplementation(function boundedIncludes(
      this: string,
      searchString: string,
      position?: number,
    ) {
      if (this.length >= hugeMessage.length && searchString.startsWith('needle-')) hugeScans += 1;
      return originalIncludes.call(this, searchString, position);
    });
    try {
      const result = evaluateWorldbooks(evaluationInput([
        runtimeBook('work-cap', entries),
      ], { scanSources: { messages: [hugeMessage], additional: [], trigger: 'normal' } }));

      expect(result.activated).toEqual([]);
      expect(result.warnings.map((warning) => warning.code)).toContain('match_operation_limit');
      expect(hugeScans).toBeLessThanOrEqual(4);

      const blankKeyResult = evaluateWorldbooks(evaluationInput([
        runtimeBook('blank-key-work-cap', Array.from({ length: 12 }, (_, index) => worldbookEntry(`blank-${index}`, {
          keys: [' '.repeat(4_096)],
          caseSensitive: true,
          sourceOrdinal: index,
        }))),
      ], { scanSources: { messages: [hugeMessage], additional: [], trigger: 'normal' } }));
      expect(blankKeyResult.warnings.map((warning) => warning.code)).toContain('match_operation_limit');
    } finally {
      includes.mockRestore();
    }
  });
});
