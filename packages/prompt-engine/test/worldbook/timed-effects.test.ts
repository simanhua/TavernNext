import { describe, expect, it } from 'vitest';
import type { NormalizedWorldbookEntry } from '@tavernnext/st-compat';
import { evaluateWorldbooks } from '../../src/index.js';
import { evaluationInput, runtimeBook, worldbookEntry } from './fixtures.js';

describe('Worldbook timed state transitions', () => {
  it('keeps sticky entries active, starts protected cooldown when sticky ends, and reactivates after cooldown', () => {
    const books = [runtimeBook('timed', [worldbookEntry('clock', {
      constant: true, sticky: 2, cooldown: 2, content: 'clock',
    })])];
    const started = evaluateWorldbooks(evaluationInput(books, { messageIndex: 10 }));
    expect(started.activated.map((entry) => entry.activation)).toEqual(['constant']);
    expect(started.timedState).toEqual({
      messageIndex: 10,
      sticky: [{
        entryKey: 'v2|timed|string:clock@0#id:entry-clock', fingerprint: expect.any(String),
        start: 10, end: 12, protected: false,
      }],
      cooldown: [{
        entryKey: 'v2|timed|string:clock@0#id:entry-clock', fingerprint: expect.any(String),
        start: 10, end: 12, protected: false,
      }],
    });

    const held = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 11,
      previousTimedState: started.timedState,
    }));
    expect(held.activated.map((entry) => entry.activation)).toEqual(['sticky']);
    expect(held.timedState).toEqual({ ...started.timedState, messageIndex: 11 });

    const cooling = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 12,
      previousTimedState: held.timedState,
    }));
    expect(cooling.activated).toEqual([]);
    expect(cooling.excluded[0]?.reason).toBe('cooldown');
    expect(cooling.timedState).toEqual({
      messageIndex: 12,
      sticky: [],
      cooldown: [{
        entryKey: 'v2|timed|string:clock@0#id:entry-clock', fingerprint: expect.any(String),
        start: 12, end: 14, protected: true,
      }],
    });

    const restarted = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 14,
      previousTimedState: cooling.timedState,
    }));
    expect(restarted.activated.map((entry) => entry.activation)).toEqual(['constant']);
  });

  it('keeps a sticky identity stable when a colliding UID/ordinal entry is added and removed', () => {
    const original = worldbookEntry('same', {
      id: 'stable-alpha',
      sourceOrdinal: 8,
      constant: true,
      sticky: 5,
      content: 'alpha',
    });
    const duplicate = worldbookEntry('same', {
      id: 'stable-beta',
      sourceOrdinal: 8,
      constant: true,
      content: 'beta',
    });
    const started = evaluateWorldbooks(evaluationInput([
      runtimeBook('identity-cardinality', [original]),
    ], { messageIndex: 10 }));
    const originalKey = started.activated[0]!.entryKey;

    const added = evaluateWorldbooks(evaluationInput([
      runtimeBook('identity-cardinality', [original, duplicate]),
    ], {
      messageIndex: 11,
      previousTimedState: started.timedState,
    }));
    expect(added.activated.find((entry) => entry.content === 'alpha')).toMatchObject({
      entryKey: originalKey,
      activation: 'sticky',
    });
    expect(added.warnings.map((warning) => warning.code)).not.toContain('timed_entry_missing');

    const removed = evaluateWorldbooks(evaluationInput([
      runtimeBook('identity-cardinality', [original]),
    ], {
      messageIndex: 12,
      previousTimedState: added.timedState,
    }));
    expect(removed.activated).toHaveLength(1);
    expect(removed.activated[0]).toMatchObject({ entryKey: originalKey, activation: 'sticky' });
    expect(removed.warnings.map((warning) => warning.code)).not.toContain('timed_entry_missing');
  });

  it('applies delay using the supplied message index with exact boundary behavior', () => {
    const books = [runtimeBook('delay', [worldbookEntry('delayed', { constant: true, delay: 3 })])];
    const early = evaluateWorldbooks(evaluationInput(books, { messageIndex: 2 }));
    const boundary = evaluateWorldbooks(evaluationInput(books, { messageIndex: 3 }));
    expect(early.activated).toEqual([]);
    expect(early.excluded[0]?.reason).toBe('delay');
    expect(boundary.activated.map((entry) => entry.sourceUid)).toEqual(['delayed']);
  });

  it('expires effects across message-index gaps and deterministically removes unprotected future state on rewind', () => {
    const books = [runtimeBook('gaps', [worldbookEntry('entry', { constant: true, sticky: 2 })])];
    const atTen = evaluateWorldbooks(evaluationInput(books, { messageIndex: 10 }));

    const gap = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 20,
      previousTimedState: atTen.timedState,
    }));
    expect(gap.activated.map((entry) => entry.activation)).toEqual(['constant']);
    expect(gap.timedState.sticky[0]).toMatchObject({ start: 20, end: 22 });

    const rewind = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 9,
      previousTimedState: atTen.timedState,
    }));
    expect(rewind.activated.map((entry) => entry.activation)).toEqual(['constant']);
    expect(rewind.timedState.sticky[0]).toMatchObject({ start: 9, end: 11 });
  });

  it('does not mutate frozen previous state while cleaning malformed, missing, or changed effects', () => {
    const previous = {
      messageIndex: 4,
      sticky: [
        { entryKey: 'missing|string:x@0', fingerprint: 'old', start: 1, end: 9, protected: false },
        { entryKey: 'v2|state|string:valid@0#id:entry-valid', fingerprint: 'stale', start: 1, end: 9, protected: false },
      ],
      cooldown: [],
    } as const;
    Object.freeze(previous.sticky[0]);
    Object.freeze(previous.sticky[1]);
    Object.freeze(previous.sticky);
    Object.freeze(previous.cooldown);
    Object.freeze(previous);

    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('state', [worldbookEntry('valid', { constant: true, sticky: 2 })]),
    ], { messageIndex: 5, previousTimedState: previous }));

    expect(previous.sticky).toHaveLength(2);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'timed_entry_missing',
      'timed_entry_changed',
    ]);
    expect(result.activated.map((entry) => entry.activation)).toEqual(['constant']);
  });

  it.each([
    ['regex policy', { useRegex: false }],
    ['secondary policy', { selective: true, selectiveLogic: 3 }],
    ['vector policy', { vectorized: true }],
    ['probability policy', { probability: 99 }],
    ['probability switch', { useProbability: true }],
    ['group weight', { groupWeight: 25 }],
    ['group override', { groupOverride: true }],
    ['priority', { priority: 7 }],
    ['order', { order: 7 }],
    ['placement', { position: 1, depth: 7, role: 1, outletName: 'slot' }],
    ['budget policy', { ignoreBudget: true }],
    ['scan depth', { scanDepth: 1 }],
    ['case policy', { caseSensitive: true }],
    ['word policy', { matchWholeWords: true }],
    ['group scoring', { useGroupScoring: true }],
    ['recursion exclusion', { excludeRecursion: true }],
    ['recursion prevention', { preventRecursion: true }],
    ['recursion delay', { delayUntilRecursion: 1 }],
    ['character filter', { characterFilter: { isExclude: true, names: ['Nobody'], tags: [] } }],
    ['persona filter', { personaFilter: { isExclude: true, names: ['Nobody'], tags: [] } }],
    ['persona scan field', { matchPersonaDescription: true }],
    ['character scan fields', {
      matchCharacterDescription: true,
      matchCharacterPersonality: true,
      matchCharacterDepthPrompt: true,
      matchScenario: true,
      matchCreatorNotes: true,
    }],
    ['trigger policy', { triggers: ['normal'] }],
  ] satisfies Array<[string, Partial<NormalizedWorldbookEntry>]>)('invalidates sticky state when executable %s changes', (_label, change) => {
    const original = worldbookEntry('fingerprint', { constant: true, sticky: 5 });
    const started = evaluateWorldbooks(evaluationInput([
      runtimeBook('fingerprint', [original]),
    ], { messageIndex: 10 }));
    const changed = evaluateWorldbooks(evaluationInput([
      runtimeBook('fingerprint', [{ ...original, ...change }]),
    ], {
      messageIndex: 11,
      previousTimedState: started.timedState,
    }));

    expect(changed.warnings.map((warning) => warning.code)).toContain('timed_entry_changed');
    expect(changed.activated.every((entry) => entry.activation !== 'sticky')).toBe(true);
  });

  it('canonicalizes filter fields and ignores presentation-only metadata in timed fingerprints', () => {
    const original = worldbookEntry('canonical', {
      constant: true,
      sticky: 5,
      characterFilter: { isExclude: false, names: [], tags: [] },
    });
    const started = evaluateWorldbooks(evaluationInput([
      runtimeBook('canonical', [original]),
    ], { messageIndex: 10 }));
    const held = evaluateWorldbooks(evaluationInput([
      runtimeBook('canonical', [{
        ...original,
        comment: 'presentation changed',
        displayName: 'New title',
        extensions: { visualOnly: true },
        characterFilter: { tags: [], names: [], isExclude: false },
      }]),
    ], {
      messageIndex: 11,
      previousTimedState: started.timedState,
    }));

    expect(held.warnings.map((warning) => warning.code)).not.toContain('timed_entry_changed');
    expect(held.activated.map((entry) => entry.activation)).toEqual(['sticky']);
  });

  it('fails malformed timed-state elements closed with a stable warning', () => {
    const result = evaluateWorldbooks(evaluationInput([
      runtimeBook('malformed-state', [worldbookEntry('valid', { constant: true })]),
    ], {
      previousTimedState: {
        messageIndex: 3,
        sticky: [null, 42, 'bad'] as never,
        cooldown: [undefined, false] as never,
      },
      messageIndex: 4,
    }));

    expect(result.activated.map((entry) => entry.sourceUid)).toEqual(['valid']);
    expect(result.warnings).toContainEqual({
      code: 'timed_effect_invalid',
      message: 'A malformed Worldbook timed-state effect was ignored.',
    });
  });
});
