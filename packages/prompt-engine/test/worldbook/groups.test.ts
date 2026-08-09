import { describe, expect, it } from 'vitest';
import { evaluateWorldbooks } from '../../src/index.js';
import { evaluationInput, runtimeBook, worldbookEntry } from './fixtures.js';

describe('Worldbook group, probability, and ordering policy', () => {
  it('uses seeded weighted group selection and produces a different winner for a different seed', () => {
    const books = [runtimeBook('groups', [
      worldbookEntry('light', { constant: true, group: 'weather', groupWeight: 25 }),
      worldbookEntry('heavy', { constant: true, group: 'weather', groupWeight: 75, sourceOrdinal: 1 }),
    ])];

    const seedOne = evaluateWorldbooks(evaluationInput(books, { seed: 1 }));
    const seedFour = evaluateWorldbooks(evaluationInput(books, { seed: 4 }));
    expect(seedOne.activated.map((entry) => entry.sourceUid)).toEqual(['heavy']);
    expect(seedFour.activated.map((entry) => entry.sourceUid)).toEqual(['light']);
    expect(seedOne.excluded[0]?.reason).toBe('group_loser');
    expect(seedFour.excluded[0]?.reason).toBe('group_loser');
  });

  it('consumes seeded group rolls in first-occurrence order instead of lexical group-name order', () => {
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('group-order', [
      worldbookEntry('z-one', { constant: true, group: 'z', groupWeight: 50, order: 200 }),
      worldbookEntry('z-two', { constant: true, group: 'z', groupWeight: 50, order: 200, sourceOrdinal: 1 }),
      worldbookEntry('a-one', { constant: true, group: 'a', groupWeight: 50, order: 100, sourceOrdinal: 2 }),
      worldbookEntry('a-two', { constant: true, group: 'a', groupWeight: 50, order: 100, sourceOrdinal: 3 }),
    ])], { seed: 1 }));

    expect(result.activated.map((entry) => entry.sourceUid)).toEqual(['z-two', 'a-one']);
  });

  it('treats a previously active multi-group string as exact when suppressing later groups', () => {
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('active-group', [
      worldbookEntry('multi', { keys: ['alpha'], content: 'beta', group: 'a,b', order: 200 }),
      worldbookEntry('a-weighted', { keys: ['beta'], group: 'a', order: 100, sourceOrdinal: 1 }),
      worldbookEntry('a-override', { keys: ['beta'], group: 'a', groupOverride: true, order: 90, sourceOrdinal: 2 }),
    ], { recursiveScanning: true })], {
      scanSources: { messages: ['alpha'], additional: [], trigger: 'normal' },
    }));

    expect(result.activated.map((entry) => entry.sourceUid)).toEqual(['multi', 'a-override']);
    expect(result.excluded.find((entry) => entry.sourceUid === 'a-weighted')?.reason).toBe('group_loser');
  });

  it('selects the highest-ranked group override before weighting', () => {
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('override', [
      worldbookEntry('weighted', { constant: true, group: 'g', groupWeight: 1_000 }),
      worldbookEntry('override-low', { constant: true, group: 'g', groupOverride: true, order: 5, sourceOrdinal: 1 }),
      worldbookEntry('override-high', { constant: true, group: 'g', groupOverride: true, order: 9, sourceOrdinal: 2 }),
    ])]));

    expect(result.activated.map((entry) => entry.sourceUid)).toEqual(['override-high']);
    expect(result.excluded.map((entry) => [entry.sourceUid, entry.reason])).toEqual([
      ['weighted', 'group_loser'],
      ['override-low', 'group_loser'],
    ]);
  });

  it('uses group match scoring when enabled and lets an active sticky group member win', () => {
    const oneKey = worldbookEntry('one-key', {
      keys: ['alpha'], group: 'g', useGroupScoring: true, sticky: 10,
    });
    const books = [runtimeBook('score', [
      oneKey,
      worldbookEntry('two-keys', { keys: ['alpha', 'beta'], group: 'g', useGroupScoring: true, sourceOrdinal: 1 }),
    ])];
    const scored = evaluateWorldbooks(evaluationInput(books, {
      scanSources: { messages: ['alpha beta'], additional: [], trigger: 'normal' },
    }));
    expect(scored.activated.map((entry) => entry.sourceUid)).toEqual(['two-keys']);

    const stickyStarted = evaluateWorldbooks(evaluationInput([
      runtimeBook('score', [oneKey]),
    ], {
      messageIndex: 4,
      scanSources: { messages: ['alpha'], additional: [], trigger: 'normal' },
    }));
    const sticky = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 5,
      scanSources: { messages: ['alpha beta'], additional: [], trigger: 'normal' },
      previousTimedState: stickyStarted.timedState,
    }));
    expect(sticky.activated.map((entry) => entry.sourceUid)).toEqual(['one-key']);
  });

  it('rolls entry probability from the supplied seed and never rerolls a failed entry during recursion', () => {
    const result = evaluateWorldbooks(evaluationInput([runtimeBook('probability', [
      worldbookEntry('coin', {
        constant: true, useProbability: true, probability: 50, content: 'recursive-key',
      }),
      worldbookEntry('recursive', { keys: ['recursive-key'], sourceOrdinal: 1 }),
    ], { recursiveScanning: true })], { seed: 1 }));

    expect(result.activated).toEqual([]);
    expect(result.excluded.find((entry) => entry.sourceUid === 'coin')?.reason).toBe('probability');
    expect(result.recursionSteps).toBe(1);
  });

  it('orders by priority, order, typed UID, source ordinal, and locked book order', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('book-b', [
        worldbookEntry('same', { constant: true, priority: 2, order: 1, sourceOrdinal: 2 }),
        worldbookEntry('same', { id: 'duplicate-two', constant: true, priority: 2, order: 1, sourceOrdinal: 1 }),
        worldbookEntry(7, { constant: true, priority: 2, order: 1, sourceOrdinal: 3 }),
      ]),
      runtimeBook('book-a', [
        worldbookEntry('top', { constant: true, priority: 3, order: 0 }),
        worldbookEntry('order', { constant: true, priority: null, order: 999, sourceOrdinal: 1 }),
      ]),
    ]));

    expect(result.activated.map((entry) => [entry.bookId, entry.sourceUid, entry.sourceOrdinal])).toEqual([
      ['book-a', 'top', 0],
      ['book-b', 7, 3],
      ['book-b', 'same', 1],
      ['book-b', 'same', 2],
      ['book-a', 'order', 1],
    ]);
    expect(new Set(result.activated.map((entry) => entry.entryKey)).size).toBe(5);
  });

  it('returns byte-identical results for repeated seed/input and never mutates source books', () => {
    const input = evaluationInput([runtimeBook('repeat', [
      worldbookEntry('a', { constant: true, group: 'g', groupWeight: 1 }),
      worldbookEntry('b', { constant: true, group: 'g', groupWeight: 1, sourceOrdinal: 1 }),
    ])], { seed: 'repeatable-seed' });
    const before = JSON.stringify(input);

    const first = evaluateWorldbooks(input);
    const second = evaluateWorldbooks(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps typed UID and source-ordinal entry keys stable when entries are reordered', () => {
    const alpha = worldbookEntry('same', { constant: true, sourceOrdinal: 8 });
    const beta = worldbookEntry(7, { constant: true, sourceOrdinal: 9 });
    const forward = evaluateWorldbooks(evaluationInput([runtimeBook('stable-book', [alpha, beta])]));
    const reversed = evaluateWorldbooks(evaluationInput([runtimeBook('stable-book', [beta, alpha])]));
    const keys = (result: ReturnType<typeof evaluateWorldbooks>) => Object.fromEntries(
      result.activated.map((entry) => [`${typeof entry.sourceUid}:${String(entry.sourceUid)}`, entry.entryKey]),
    );

    expect(keys(reversed)).toEqual(keys(forward));
  });

  it('uses stable entry ids to disambiguate duplicate typed UID and source-ordinal identities', () => {
    const alpha = worldbookEntry('same', {
      id: 'stable-alpha', constant: true, sourceOrdinal: 8, content: 'alpha',
    });
    const beta = worldbookEntry('same', {
      id: 'stable-beta', constant: true, sourceOrdinal: 8, content: 'beta',
    });
    const forward = evaluateWorldbooks(evaluationInput([runtimeBook('duplicates', [alpha, beta])]));
    const reversed = evaluateWorldbooks(evaluationInput([runtimeBook('duplicates', [beta, alpha])]));
    const projection = (result: ReturnType<typeof evaluateWorldbooks>) => result.activated.map((entry) => ({
      content: entry.content,
      entryKey: entry.entryKey,
    }));

    expect(projection(reversed)).toEqual(projection(forward));
    expect(new Set(forward.activated.map((entry) => entry.entryKey)).size).toBe(2);
    expect(forward.activated.every((entry) => entry.entryKey.includes('stable-'))).toBe(true);
  });

  it('rejects entries whose complete stable identities are duplicates', () => {
    const duplicate = worldbookEntry('same', {
      id: 'same-id', constant: true, sourceOrdinal: 8,
    });
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('exact-duplicates', [duplicate, { ...duplicate }]),
    ]));

    expect(result.activated).toEqual([]);
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded.every((entry) => entry.reason === 'invalid_entry')).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'invalid_entry',
      message: 'Worldbook entries with the same stable identity were rejected.',
    }));
  });

  it('creates deterministic entry keys for arbitrary UTF-16 string identities', () => {
    const input = evaluationInput([runtimeBook(`book-\ud800`, [
      worldbookEntry(`uid-\udfff`, { constant: true }),
    ])]);

    expect(() => evaluateWorldbooks(input)).not.toThrow();
    expect(evaluateWorldbooks(input).activated[0]?.entryKey).toBe(evaluateWorldbooks(input).activated[0]?.entryKey);
  });
});
