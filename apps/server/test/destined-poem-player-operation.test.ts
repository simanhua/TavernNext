import { describe, expect, it } from 'vitest';
// The official Scene server module is a framework-free native ES module.
// @ts-expect-error The runtime asset has no declaration file.
import destinedPoemServer from '../assets/official-scenes/destined-poem/server/index.mjs';

describe('Destined Poem player operations', () => {
  it('validates attribute allocation and returns one authoritative state patch', async () => {
    const initialized = await destinedPoemServer.initializeConversation({
      setup: { opening: 'summoned-hero', origin: 'ignored' },
      playerProfile: { name: '艾琳', description: '来自云端的见证者' },
    });
    const state = structuredClone(initialized.initialState);
    state.主角.属性点 = 2;
    const before = state.主角;

    const accepted = await destinedPoemServer.handleAction({
      action: { type: 'allocate-attribute', attribute: '力量' },
      state,
    });
    expect(accepted).toEqual({
      accepted: true,
      statePatch: [
        { op: 'delta', path: '/主角/属性点', value: -1 },
        { op: 'delta', path: '/主角/属性/力量', value: 1 },
      ],
      result: {
        ok: true,
        attribute: '力量',
        before: before.属性.力量,
        after: before.属性.力量 + 1,
        remainingPoints: before.属性点 - 1,
      },
    });

    await expect(destinedPoemServer.handleAction({
      action: { type: 'allocate-attribute', attribute: '幸运' },
      state,
    })).resolves.toEqual({ accepted: false, result: { ok: false, code: 'attribute_allocation_invalid' } });
    await expect(destinedPoemServer.handleAction({
      action: { type: 'allocate-attribute', attribute: '力量' },
      state: { ...state, 主角: { ...before, 属性点: 0 } },
    })).resolves.toEqual({ accepted: false, result: { ok: false, code: 'attribute_points_exhausted' } });
  });
});
