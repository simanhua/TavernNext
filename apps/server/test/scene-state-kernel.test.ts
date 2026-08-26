import { describe, expect, it } from 'vitest';
import {
  applyScenePatch,
  applyScenePatchPartial,
  assertSceneState,
} from '../src/scenes/scene-service.js';

describe('Scene State Kernel', () => {
  it('uses the legacy MVU operations without field-schema validation', () => {
    const state = { points: 2, inventory: {}, queue: ['first'], nested: { source: 'value' } };
    assertSceneState(state, { stateSchema: { type: 'not-a-json-schema-type' } } as never);
    const updated = applyScenePatch(state, [
      { op: 'delta', path: '/points', value: -3 },
      { op: 'insert', path: '/inventory/key', value: { count: 1 } },
      { op: 'insert', path: '/queue/-', value: 'second' },
      { op: 'move', from: '/nested/source', to: '/nested/target' },
      { op: 'remove', path: '/queue/0' },
    ]);
    expect(updated).toEqual({
      points: -1,
      inventory: { key: { count: 1 } },
      queue: ['second'],
      nested: { target: 'value' },
    });
  });

  it('creates missing object parents for legacy insert and reports independent failures', () => {
    const applied = applyScenePatchPartial({ points: 1, inventory: {} }, [
      { op: 'replace', path: '/points', value: 2 },
      { op: 'delta', path: '/missing', value: 1 },
      { op: 'insert', path: '/inventory/key', value: 'kept' },
      { op: 'insert', path: '/missing/child', value: true },
      { op: 'replace', path: '/points' },
    ]);
    expect(applied.value).toEqual({ points: 2, inventory: { key: 'kept' }, missing: { child: true } });
    expect(applied.operations).toHaveLength(3);
    expect(applied.failures).toEqual([
      expect.objectContaining({ operationIndex: 1, op: 'delta', path: '/missing', code: 'scene_patch_invalid' }),
      expect.objectContaining({ operationIndex: 4, op: 'replace', path: '/points', code: 'scene_patch_operation_invalid' }),
    ]);
  });

  it('does not create missing parents for replace, delta, or remove', () => {
    const applied = applyScenePatchPartial({}, [
      { op: 'replace', path: '/missing/value', value: 1 },
      { op: 'delta', path: '/missing/value', value: 1 },
      { op: 'remove', path: '/missing/value' },
    ]);
    expect(applied.value).toEqual({});
    expect(applied.failures).toHaveLength(3);
  });
});
