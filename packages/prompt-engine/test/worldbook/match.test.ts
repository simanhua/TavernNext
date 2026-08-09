import { describe, expect, it, vi } from 'vitest';
import { evaluateWorldbooks } from '../../src/index.js';
import { evaluationInput, runtimeBook, worldbookEntry } from './fixtures.js';

function activatedUids(result: ReturnType<typeof evaluateWorldbooks>): Array<string | number> {
  return result.activated.map((entry) => entry.sourceUid);
}

function excludedReason(result: ReturnType<typeof evaluateWorldbooks>, uid: string | number): string | undefined {
  return result.excluded.find((entry) => entry.sourceUid === uid)?.reason;
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
});
