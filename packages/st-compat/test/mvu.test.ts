import { describe, expect, it } from 'vitest';
import { applyMvuMessage, createMvuState } from '../src/mvu.js';

describe('MVU compatibility state', () => {
  it('rejects prototype-bearing InitVar keys and JSON Pointer segments', () => {
    const state = createMvuState([{
      id: 'unsafe-init',
      content: `safe: 1\nconstructor:\n  prototype:\n    polluted: true`,
    }]);
    const patched = applyMvuMessage(state, `<UpdateVariable><JSONPatch>[
      { "op": "replace", "path": "/__proto__/polluted", "value": true },
      { "op": "replace", "path": "/safe", "value": 2 }
    ]</JSONPatch></UpdateVariable>`);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(patched.stat_data).toEqual({ safe: 2 });
  });
});
