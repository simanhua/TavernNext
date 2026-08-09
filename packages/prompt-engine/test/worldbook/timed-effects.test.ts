import { describe, expect, it } from 'vitest';
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
        entryKey: 'timed|string:clock@0', fingerprint: expect.any(String),
        start: 10, end: 12, protected: false,
      }],
      cooldown: [{
        entryKey: 'timed|string:clock@0', fingerprint: expect.any(String),
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
        entryKey: 'timed|string:clock@0', fingerprint: expect.any(String),
        start: 12, end: 14, protected: true,
      }],
    });

    const restarted = evaluateWorldbooks(evaluationInput(books, {
      messageIndex: 14,
      previousTimedState: cooling.timedState,
    }));
    expect(restarted.activated.map((entry) => entry.activation)).toEqual(['constant']);
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
        { entryKey: 'state|string:valid@0', fingerprint: 'stale', start: 1, end: 9, protected: false },
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
});
