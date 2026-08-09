import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_WORLDBOOK_CONTENT_CHARACTERS,
  MAX_WORLDBOOK_RUNTIME_ENTRIES,
  MAX_WORLDBOOK_SCAN_CHARACTERS,
  MAX_WORLDBOOK_TOTAL_ENTRY_CHARACTERS,
  MAX_WORLDBOOK_WARNINGS,
  evaluateWorldbooks,
} from '../../src/index.js';
import { evaluationInput, runtimeBook, worldbookEntry } from './fixtures.js';

describe('Worldbook recursion and budgeting', () => {
  it('recursively scans only activated content until stable', () => {
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('recursive', [
      worldbookEntry('first', { keys: ['alpha'], content: 'beta', order: 20 }),
      worldbookEntry('second', { keys: ['beta'], content: 'gamma', order: 10, sourceOrdinal: 1 }),
      worldbookEntry('third', { keys: ['gamma'], content: 'done', order: 0, sourceOrdinal: 2 }),
    ], { recursiveScanning: true })], {
      scanSources: { messages: ['alpha'], additional: [], trigger: 'normal' },
    }));

    expect(result.activated.map((entry) => [entry.sourceUid, entry.activationStep])).toEqual([
      ['first', 0], ['second', 1], ['third', 2],
    ]);
    expect(result.recursionSteps).toBe(3);
  });

  it('joins entries activated in one pass with plain newlines and marks only boundaries between recursion passes', () => {
    const samePass = evaluateWorldbooks(evaluationInput([runtimeBook('same-pass', [
      worldbookEntry('alpha', { constant: true, content: 'alpha', order: 20 }),
      worldbookEntry('beta', { constant: true, content: 'beta', order: 10, sourceOrdinal: 1 }),
      worldbookEntry('plain-newline', { keys: ['/alpha\\nbeta/'], content: 'matched', order: 0, sourceOrdinal: 2 }),
    ], { recursiveScanning: true })]));
    expect(samePass.activated.map((entry) => entry.sourceUid)).toEqual(['alpha', 'beta', 'plain-newline']);

    const separatePasses = evaluateWorldbooks(evaluationInput([runtimeBook('separate-passes', [
      worldbookEntry('alpha', { constant: true, content: 'alpha', order: 20 }),
      worldbookEntry('beta', { keys: ['alpha'], content: 'beta', order: 10, sourceOrdinal: 1 }),
      worldbookEntry('segment-marker', { keys: ['/alpha\\n\\x01beta/'], content: 'matched', order: 0, sourceOrdinal: 2 }),
    ], { recursiveScanning: true })]));
    expect(separatePasses.activated.map((entry) => entry.sourceUid)).toEqual(['alpha', 'beta', 'segment-marker']);
  });

  it('honors excludeRecursion, preventRecursion, delayUntilRecursion, and the recursion cap', () => {
    const excluded = evaluateWorldbooks(evaluationInput([runtimeBook('exclude', [
      worldbookEntry('first', { keys: ['alpha'], content: 'beta' }),
      worldbookEntry('excluded', { keys: ['beta'], excludeRecursion: true, sourceOrdinal: 1 }),
    ], { recursiveScanning: true })], {
      scanSources: { messages: ['alpha'], additional: [], trigger: 'normal' },
    }));
    expect(excluded.activated.map((entry) => entry.sourceUid)).toEqual(['first']);
    expect(excluded.excluded.find((entry) => entry.sourceUid === 'excluded')?.reason).toBe('recursion_excluded');

    const prevented = evaluateWorldbooks(evaluationInput([runtimeBook('prevent', [
      worldbookEntry('first', { keys: ['alpha'], content: 'beta', preventRecursion: true }),
      worldbookEntry('second', { keys: ['beta'], sourceOrdinal: 1 }),
    ], { recursiveScanning: true })], {
      scanSources: { messages: ['alpha'], additional: [], trigger: 'normal' },
    }));
    expect(prevented.activated.map((entry) => entry.sourceUid)).toEqual(['first']);

    const delayed = evaluateWorldbooks(evaluationInput([runtimeBook('delayed-recursion', [
      worldbookEntry('delayed', { constant: true, delayUntilRecursion: 2 }),
    ])]));
    expect(delayed.activated.map((entry) => [entry.sourceUid, entry.activationStep])).toEqual([['delayed', 2]]);

    const capped = evaluateWorldbooks(evaluationInput([runtimeBook('cap', [
      worldbookEntry('a', { keys: ['a'], content: 'b' }),
      worldbookEntry('b', { keys: ['b'], content: 'c', sourceOrdinal: 1 }),
      worldbookEntry('c', { keys: ['c'], sourceOrdinal: 2 }),
    ], { recursiveScanning: true })], {
      scanSources: { messages: ['a'], additional: [], trigger: 'normal' },
      settings: { maxRecursionSteps: 2 },
    }));
    expect(capped.activated.map((entry) => entry.sourceUid)).toEqual(['a', 'b']);
    expect(capped.excluded.find((entry) => entry.sourceUid === 'c')?.reason).toBe('recursion_limit');
    expect(capped.warnings.map((warning) => warning.code)).toContain('recursion_limit');
  });

  it('extends newest-first chat depth to satisfy minimum activations without scanning past max depth', () => {
    const books = [runtimeBook('minimum', [worldbookEntry('older', { keys: ['old-key'] })])];
    const found = evaluateWorldbooks(evaluationInput(books, {
      scanSources: { messages: ['recent', 'old-key'], additional: [], trigger: 'normal' },
      settings: { scanDepth: 1, minActivations: 1, minActivationsDepthMax: 2 },
    }));
    expect(found.activated.map((entry) => [entry.sourceUid, entry.activationStep])).toEqual([['older', 1]]);

    const capped = evaluateWorldbooks(evaluationInput(books, {
      scanSources: { messages: ['recent', 'middle', 'old-key'], additional: [], trigger: 'normal' },
      settings: { scanDepth: 1, minActivations: 1, minActivationsDepthMax: 2 },
    }));
    expect(capped.activated).toEqual([]);
    expect(capped.excluded[0]?.reason).toBe('primary_key_miss');
  });

  it('uses exact combined token counts with ST strict budget boundaries, zero budgets, and ignoreBudget', () => {
    const tokenizerInputs: string[] = [];
    const tokenizer = { countText: (text: string) => {
      tokenizerInputs.push(text);
      return text.length;
    } };
    const fits = evaluateWorldbooks(evaluationInput([runtimeBook('fits', [
      worldbookEntry('fits', { constant: true, content: 'AB' }),
    ])], { tokenBudget: 4, tokenizer }));
    expect(fits.activated.map((entry) => entry.sourceUid)).toEqual(['fits']);
    expect(fits.tokenUsage).toEqual({ budget: 4, used: 3, overflowed: false });
    expect(tokenizerInputs).toEqual(['', 'AB\n']);

    tokenizerInputs.splice(0);
    const trailingBoundary = evaluateWorldbooks(evaluationInput([runtimeBook('trailing-boundary', [
      worldbookEntry('boundary', { constant: true, content: 'AB' }),
    ])], { tokenBudget: 3, tokenizer }));
    expect(trailingBoundary.activated).toEqual([]);
    expect(trailingBoundary.excluded[0]?.reason).toBe('budget');
    expect(trailingBoundary.tokenUsage).toEqual({ budget: 3, used: 0, overflowed: true });
    expect(tokenizerInputs).toEqual(['', 'AB\n']);

    const exact = evaluateWorldbooks(evaluationInput([runtimeBook('exact', [
      worldbookEntry('exact', { constant: true, content: 'AB' }),
    ])], { tokenBudget: 2, tokenizer }));
    expect(exact.activated).toEqual([]);
    expect(exact.excluded[0]?.reason).toBe('budget');
    expect(exact.tokenUsage).toEqual({ budget: 2, used: 0, overflowed: true });

    const zero = evaluateWorldbooks(evaluationInput([runtimeBook('zero', [
      worldbookEntry('normal', { constant: true, content: 'A' }),
      worldbookEntry('ignored', { constant: true, content: 'B', ignoreBudget: true, sourceOrdinal: 1 }),
    ])], { tokenBudget: 0, tokenizer }));
    expect(zero.activated.map((entry) => entry.sourceUid)).toEqual(['ignored']);
    expect(zero.tokenUsage).toEqual({ budget: 0, used: 0, overflowed: true });

    const combined = evaluateWorldbooks(evaluationInput([runtimeBook('combined', [
      worldbookEntry('a', { constant: true, content: 'A', order: 2 }),
      worldbookEntry('b', { constant: true, content: 'B', order: 1, sourceOrdinal: 1 }),
    ])], {
      tokenBudget: 2,
      tokenizer: { countText: (text) => ({ 'A\n': 1, 'B\n': 1, 'A\nB\n': 1 }[text] ?? text.length) },
    }));
    expect(combined.activated.map((entry) => entry.sourceUid)).toEqual(['a', 'b']);
    expect(combined.tokenUsage.used).toBe(1);
  });

  it('retains rejected text in the ST accumulator and never tokenizes ignoreBudget entries', () => {
    const tokenizerInputs: string[] = [];
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('upstream-accumulator', [
      worldbookEntry('normal-a', { constant: true, content: 'A', order: 2 }),
      worldbookEntry('ignored-b', {
        constant: true,
        content: 'B',
        ignoreBudget: true,
        order: 1,
        sourceOrdinal: 1,
      }),
    ])], {
      tokenBudget: 2,
      tokenizer: {
        countText(text) {
          tokenizerInputs.push(text);
          if (text.includes('B')) throw new Error('ignoreBudget content reached the tokenizer');
          return text.length;
        },
      },
    }));

    expect(tokenizerInputs).toEqual(['', 'A\n']);
    expect(result.activated.map((entry) => entry.sourceUid)).toEqual(['ignored-b']);
    expect(result.excluded.map((entry) => [entry.sourceUid, entry.reason])).toEqual([
      ['normal-a', 'budget'],
    ]);
    expect(result.tokenUsage).toEqual({ budget: 2, used: 0, overflowed: true });
    expect(result.activated[0]?.tokenUsageAfter).toBe(0);
  });

  it('allocates sticky entries before newly matched entries when the strict budget fits only one', () => {
    const stickyEntry = worldbookEntry('sticky-low', {
      constant: true, sticky: 5, content: 'S', order: 1,
    });
    const started = evaluateWorldbooks(evaluationInput([
      runtimeBook('sticky-budget', [stickyEntry]),
    ], { messageIndex: 10 }));

    const held = evaluateWorldbooks(evaluationInput([runtimeBook('sticky-budget', [
      stickyEntry,
      worldbookEntry('new-high', { constant: true, content: 'N', order: 100, sourceOrdinal: 1 }),
    ])], {
      messageIndex: 11,
      previousTimedState: started.timedState,
      tokenBudget: 3,
    }));

    expect(held.activated.map((entry) => [entry.sourceUid, entry.activation])).toEqual([['sticky-low', 'sticky']]);
    expect(held.excluded.find((entry) => entry.sourceUid === 'new-high')?.reason).toBe('budget');
  });

  it('turns tokenizer exceptions and invalid counts into stable exclusions without throwing', () => {
    for (const countText of [
      () => { throw new Error('private tokenizer detail'); },
      () => Number.NaN,
    ]) {
      const result = evaluateWorldbooks(evaluationInput([runtimeBook('tokenizer', [
        worldbookEntry('first', { constant: true }),
        worldbookEntry('second', { constant: true, sourceOrdinal: 1 }),
      ])], { tokenizer: { countText } }));
      expect(result.activated).toEqual([]);
      expect(result.excluded.map((entry) => entry.reason)).toEqual(['tokenizer_error', 'tokenizer_error']);
      expect(result.warnings).toEqual([{
        code: 'tokenizer_error',
        message: 'The Worldbook tokenizer failed or returned an invalid count.',
      }]);
    }
  });

  it('rejects malformed entries while valid siblings continue', () => {
    const malformed = worldbookEntry('malformed', { constant: true }) as unknown as Record<string, unknown>;
    malformed.content = 42;
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('invalid', [
      malformed as never,
      worldbookEntry('valid', { constant: true }),
    ])]));
    expect(result.activated.map((entry) => entry.sourceUid)).toEqual(['valid']);
    expect(result.excluded.find((entry) => entry.sourceUid === 'malformed')?.reason).toBe('invalid_entry');
    expect(result.warnings[0]?.code).toBe('invalid_entry');
  });

  it('fails closed before tokenization when entry or scan-source caps are exceeded', () => {
    const countText = vi.fn(() => 1);
    const tooMany = Array.from({ length: MAX_WORLDBOOK_RUNTIME_ENTRIES + 1 }, (_, index) => worldbookEntry(index, {
      constant: true,
      sourceOrdinal: index,
    }));
    const entriesResult = evaluateWorldbooks(evaluationInput([
      runtimeBook('large', tooMany),
    ], { tokenizer: { countText } }));
    expect(entriesResult.activated).toEqual([]);
    expect(entriesResult.excluded).toEqual([]);
    expect(entriesResult.warnings[0]?.code).toBe('entry_limit');
    expect(countText).not.toHaveBeenCalled();

    const sourceResult = evaluateWorldbooks(evaluationInput([
      runtimeBook('source', [worldbookEntry('entry', { constant: true })]),
    ], {
      tokenizer: { countText },
      scanSources: {
        messages: ['x'.repeat(MAX_WORLDBOOK_SCAN_CHARACTERS + 1)],
        additional: [],
        trigger: 'normal',
      },
    }));
    expect(sourceResult.activated).toEqual([]);
    expect(sourceResult.excluded[0]?.reason).toBe('evaluation_limit');
    expect(sourceResult.warnings[0]?.code).toBe('scan_source_limit');
    expect(countText).not.toHaveBeenCalled();
  });

  it('checks book, entry, and identity envelopes before probing or allocating their contents', () => {
    let bookProbes = 0;
    const tooManyBooks = new Proxy(
      Array.from({ length: 65 }, () => runtimeBook('unread', [])),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            bookProbes += 1;
            throw new Error('book contents must remain unread');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const booksResult = evaluateWorldbooks(evaluationInput(tooManyBooks));
    expect(booksResult.warnings[0]?.code).toBe('book_limit');
    expect(bookProbes).toBe(0);

    let entryProbes = 0;
    const tooManyEntries = new Proxy(
      Array.from({ length: MAX_WORLDBOOK_RUNTIME_ENTRIES + 1 }, () => worldbookEntry('unread')),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            entryProbes += 1;
            throw new Error('entry contents must remain unread');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const entriesBook = runtimeBook('entry-envelope', []);
    entriesBook.book.entries = tooManyEntries;
    const entryResult = evaluateWorldbooks(evaluationInput([entriesBook]));
    expect(entryResult.warnings[0]?.code).toBe('entry_limit');
    expect(entryProbes).toBe(0);

    let identityEntryProbes = 0;
    const identityEntries = new Proxy([worldbookEntry('unread')], {
      get(target, property, receiver) {
        if (property === '0') {
          identityEntryProbes += 1;
          throw new Error('entries behind an oversized book identity must remain unread');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const identityBook = runtimeBook('x'.repeat(4_097), []);
    identityBook.book.entries = identityEntries;
    const identityResult = evaluateWorldbooks(evaluationInput([identityBook]));
    expect(identityResult.warnings[0]?.code).toBe('identity_limit');
    expect(identityEntryProbes).toBe(0);

    let nestedCollectionProbes = 0;
    const oversizedTriggers = new Proxy(
      Array.from({ length: 257 }, () => 'unread'),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            nestedCollectionProbes += 1;
            throw new Error('oversized nested entry collections must remain unread');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const nestedEntry = worldbookEntry('nested-cap', { triggers: oversizedTriggers });
    const nestedResult = evaluateWorldbooks(evaluationInput([
      runtimeBook('nested-cap', [nestedEntry]),
    ]));
    expect(nestedResult.warnings[0]?.code).toBe('entry_collection_limit');
    expect(nestedCollectionProbes).toBe(0);
  });

  it('caps aggregate entry text before matching or tokenization', () => {
    const countText = vi.fn(() => 1);
    const sharedContent = 'x'.repeat(MAX_WORLDBOOK_CONTENT_CHARACTERS);
    const entryCount = Math.floor(MAX_WORLDBOOK_TOTAL_ENTRY_CHARACTERS / sharedContent.length) + 1;
    const entries = Array.from({ length: entryCount }, (_, index) => worldbookEntry(index, {
      constant: true,
      content: sharedContent,
      sourceOrdinal: index,
    }));
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('aggregate-limit', entries),
    ], { tokenizer: { countText } }));

    expect(result.activated).toEqual([]);
    expect(result.excluded).toHaveLength(entryCount);
    expect(result.excluded.every((entry) => entry.reason === 'evaluation_limit')).toBe(true);
    expect(result.warnings[0]?.code).toBe('entry_character_limit');
    expect(countText).not.toHaveBeenCalled();
  });

  it('keeps warning output within its public cap and records truncation deterministically', () => {
    const invalidKeys = Array.from({ length: 200 }, (_, index) => `/[${index}-/`);
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('warnings', [
      worldbookEntry('first', { keys: invalidKeys }),
      worldbookEntry('second', { keys: invalidKeys, sourceOrdinal: 1 }),
    ])], { scanSources: { messages: ['anything'], additional: [], trigger: 'normal' } }));

    expect(result.warnings).toHaveLength(MAX_WORLDBOOK_WARNINGS);
    expect(result.warnings.at(-1)?.code).toBe('warnings_truncated');
  });

  it('matches the complete original synthetic runtime golden including provenance', () => {
    const fixturePath = fileURLToPath(new URL('../../../../tests/fixtures/worldbooks/runtime-golden.json', import.meta.url));
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      provenance: Record<string, string>;
      expected: unknown;
    };
    expect(fixture.provenance).toEqual({
      origin: 'Original synthetic TavernNext fixture; no upstream content copied.',
      baseline: 'SillyTavern 1.18.0 world-info behavior, hand-derived.',
      purpose: 'Complete deterministic activation, exclusion, state, ordering, and token ledger.',
    });

    const result = evaluateWorldbooks(evaluationInput([runtimeBook('golden-book', [
      worldbookEntry('constant', { constant: true, content: 'CONST', order: 10, sourceOrdinal: 0 }),
      worldbookEntry('dragon', { keys: ['dragon'], content: 'DRAGON', order: 20, sourceOrdinal: 1 }),
      worldbookEntry('missing', { keys: ['missing'], content: 'MISSING', order: 5, sourceOrdinal: 2 }),
    ])], {
      seed: 'golden-seed',
      messageIndex: 4,
      scanSources: { messages: ['a dragon arrives'], additional: [], trigger: 'normal' },
      tokenBudget: 64,
    }));
    expect(result).toEqual(fixture.expected);
  });
});
