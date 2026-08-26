import type { SceneManifest } from '@tavernnext/domain';
import { describe, expect, it } from 'vitest';
import type { PromptSnapshotPayload } from '../src/services/prompt-snapshot-service.js';
import { TurnWorkspace } from '../src/services/turn-workspace.js';

function payload(): PromptSnapshotPayload {
  return {
    seed: 'fixed-seed',
    executable: {
      worldbooks: [{
        id: '018f0000-0000-7000-8000-000000000301',
        source: 'conversation',
        book: {
          name: 'Archive Lore',
          entries: [{
            id: '018f0000-0000-7000-8000-000000000304', keys: ['archive', 'vault'], secondaryKeys: ['records'],
            content: 'The archive vault opens only at dusk.', enabled: true,
          }],
        },
      }],
    },
  } as unknown as PromptSnapshotPayload;
}

async function execute(workspace: TurnWorkspace, name: string, params: unknown) {
  const tool = workspace.tools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.execute(`call-${name}`, params, new AbortController().signal);
}

function detail<T>(value: { details: unknown }): T {
  return value.details as T;
}

describe('TurnWorkspace', () => {
  it('offers only bounded platform tools and exposes later staged state to later calls', async () => {
    const sourcePayload = payload();
    const sourceManifest = { stateSchema: { original: true } } as unknown as SceneManifest;
    const sourceState = {
      revision: 7,
      value: { points: 2, map: { place: 'gate' } },
      manifest: sourceManifest,
    };
    const workspace = new TurnWorkspace({
      generationId: '018f0000-0000-7000-8000-000000000302',
      payload: sourcePayload,
      state: sourceState,
    });
    const names = workspace.tools().map((tool) => tool.name);
    expect(names).toEqual(['save_state_read', 'world_query', 'deterministic_check', 'scene_patch_stage']);
    expect(names.join(' ')).not.toMatch(/bash|shell|file|network|http|code|exec/i);

    const frozenCheck = detail<Record<string, unknown>>(
      await execute(workspace, 'deterministic_check', { key: 'frozen-input', difficulty: 10 }),
    );
    sourcePayload.seed = 'mutated-seed';
    sourceState.revision = 99;
    sourceState.value.points = 999;
    sourceManifest.stateSchema = { mutated: true };
    expect(detail(await execute(workspace, 'deterministic_check', {
      key: 'frozen-input', difficulty: 10,
    }))).toEqual(frozenCheck);
    expect(workspace.snapshot()).toMatchObject({
      stateRevision: 7,
      baseValue: { points: 2, map: { place: 'gate' } },
      stagedValue: { points: 2, map: { place: 'gate' } },
    });

    const patch = detail<{
      ok: boolean;
      applied: unknown[];
      failures: Array<{ operationIndex: number; code: string }>;
      stagedState: Record<string, unknown>;
    }>(await execute(workspace, 'scene_patch_stage', { operations: [
      { op: 'delta', path: '/points', value: 3 },
      { op: 'delta', path: '/missing', value: 1 },
      { op: 'replace', path: '/map/place', value: 'vault' },
    ] }));
    expect(patch).toMatchObject({
      ok: false,
      appliedCount: 2,
      applied: [
        { op: 'delta', path: '/points' },
        { op: 'replace', path: '/map/place' },
      ],
      failures: [{ operationIndex: 1, code: 'scene_patch_invalid' }],
      failureCount: 1,
      stagedOperationCount: 2,
    });

    const read = detail<{ values: Array<{ path: string; ok: boolean; value?: unknown }> }>(
      await execute(workspace, 'save_state_read', { paths: ['/points', '/map/place', '/missing'] }),
    );
    expect(read.values).toEqual([
      { path: '/points', ok: true, value: 5 },
      { path: '/map/place', ok: true, value: 'vault' },
      { path: '/missing', ok: false, code: 'state_path_not_found' },
    ]);

    const lore = detail<{ results: Array<{ entryKey: string; content: string }> }>(
      await execute(workspace, 'world_query', { query: 'archive dusk', limit: 4 }),
    );
    expect(lore.results).toEqual([
      expect.objectContaining({
        entryKey: '018f0000-0000-7000-8000-000000000304',
        content: 'The archive vault opens only at dusk.',
      }),
    ]);

    const firstCheck = detail<Record<string, unknown>>(
      await execute(workspace, 'deterministic_check', { key: 'open-vault', difficulty: 12, modifier: 2 }),
    );
    const repeatedCheck = detail<Record<string, unknown>>(
      await execute(workspace, 'deterministic_check', { key: 'open-vault', difficulty: 12, modifier: 2 }),
    );
    expect(repeatedCheck).toEqual(firstCheck);
    expect(firstCheck).toMatchObject({ ok: true, key: 'open-vault', sides: 20, difficulty: 12, modifier: 2 });

    expect(workspace.snapshot()).toEqual({
      stateRevision: 7,
      baseValue: { points: 2, map: { place: 'gate' } },
      stagedValue: { points: 5, map: { place: 'vault' } },
      operations: [
        { op: 'delta', path: '/points', value: 3 },
        { op: 'replace', path: '/map/place', value: 'vault' },
      ],
      failures: [expect.objectContaining({ operationIndex: 1, code: 'scene_patch_invalid' })],
    });

    const largeWorkspace = new TurnWorkspace({
      generationId: '018f0000-0000-7000-8000-000000000305',
      payload: payload(),
      state: {
        revision: 8,
        value: { points: 1, large: 'x'.repeat(80 * 1024) },
        manifest: {} as SceneManifest,
      },
    });
    const largePatch = detail<Record<string, unknown>>(await execute(largeWorkspace, 'scene_patch_stage', {
      operations: [{ op: 'delta', path: '/points', value: 1 }],
    }));
    expect(largePatch).toMatchObject({
      ok: true,
      appliedCount: 1,
      applied: [{ op: 'delta', path: '/points' }],
      failureCount: 0,
      failures: [],
      stagedOperationCount: 1,
    });
    expect(largePatch).not.toHaveProperty('code', 'tool_result_too_large');
    expect(largeWorkspace.snapshot().stagedValue.points).toBe(2);
  });

  it('keeps state unavailable runs read-only while retaining structured patch failures', async () => {
    const workspace = new TurnWorkspace({
      generationId: '018f0000-0000-7000-8000-000000000303',
      payload: payload(),
    });
    expect(detail(await execute(workspace, 'save_state_read', {}))).toEqual({
      ok: false, code: 'scene_state_unavailable',
    });
    expect(detail(await execute(workspace, 'scene_patch_stage', {
      operations: [{ op: 'add', path: '/unsafe', value: true }],
    }))).toMatchObject({
      ok: false,
      appliedCount: 0,
      applied: [],
      failureCount: 1,
      failures: [{ operationIndex: 0, code: 'scene_state_unavailable' }],
      stagedOperationCount: 0,
    });
    expect(workspace.snapshot().stagedValue).toEqual({});
  });
});
