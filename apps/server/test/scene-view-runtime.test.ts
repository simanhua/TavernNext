import { randomUUID } from 'node:crypto';
import type { SceneManifest, SceneViewDeclaration } from '@tavernnext/domain';
import { roleplayDocumentPlainText } from '@tavernnext/domain';
import { describe, expect, it } from 'vitest';
import type { SceneModuleHost } from '../src/scenes/scene-module-host.js';
import type { PromptSnapshotPayload } from '../src/services/prompt-snapshot-service.js';
import { SceneViewRuntime } from '../src/services/scene-view-runtime.js';
import { TurnWorkspace } from '../src/services/turn-workspace.js';

const declaration: SceneViewDeclaration = {
  kind: 'combat',
  schemaVersion: 1,
  projection: {
    hook: 'projectSceneView',
    schema: {
      type: 'object', additionalProperties: false, required: ['points'],
      properties: { points: { type: 'number' } },
    },
  },
  renderer: { id: 'test-combat-v1' },
};

function workspace() {
  return new TurnWorkspace({
    generationId: randomUUID(),
    payload: { seed: 'view-test', executable: { worldbooks: [] } } as unknown as PromptSnapshotPayload,
    state: { revision: 7, value: { points: 7 }, manifest: {} as SceneManifest },
  });
}

async function stage(runtime: SceneViewRuntime, relatedEntities: string[] = []) {
  const result = await runtime.tool().execute('stage', {
    kind: 'combat', relatedEntities, insertionIntent: 'inline',
  }, new AbortController().signal);
  return (result.details as { reference: string }).reference;
}

describe('SceneViewRuntime', () => {
  it('resolves objective commit-time props and omits every invalid or unused reference with diagnostics', async () => {
    const turn = workspace();
    const host = {
      async call(_hook: string, input: unknown) {
        const value = input as { relatedEntities: string[]; workspace: { state: { points: number } } };
        if (value.relatedEntities.includes('fail')) throw new Error('projection failed');
        return { props: { points: value.workspace.state.points } };
      },
    } as unknown as SceneModuleHost;
    const runtime = new SceneViewRuntime({
      scene: { id: randomUUID(), slug: 'test', version: '1.0.0', archiveDigest: 'a'.repeat(64) },
      declarations: [declaration],
      host,
      setup: {},
      playerProfile: undefined,
      workspace: turn,
    });
    const valid = await stage(runtime);
    const failed = await stage(runtime, ['fail']);
    await stage(runtime, ['unused']);
    turn.stagePatch([{ op: 'delta', path: '/points', value: 2 }]);
    const unknown = `<!--tavernnext:view:${randomUUID()}-->`;
    const malformed = '<!--tavernnext:view:not-a-uuid-->';
    const unclosed = '<!--tavernnext:view:broken中文保留 then ';
    const resolved = await runtime.resolve(
      `Before ${valid} middle ${valid} unknown ${unknown} malformed ${malformed} unclosed ${unclosed}failed ${failed} end`,
    );

    expect(resolved.document.blocks).toEqual([
      { type: 'markdown', content: 'Before ' },
      expect.objectContaining({
        type: 'scene-view', kind: 'combat', schemaVersion: 1,
        rendererId: 'test-combat-v1', sourceStateRevision: 8, props: { points: 9 },
      }),
      { type: 'markdown', content: ' middle ' },
      { type: 'markdown', content: ' unknown ' },
      { type: 'markdown', content: ' malformed ' },
      { type: 'markdown', content: ' unclosed 中文保留 then failed ' },
      { type: 'markdown', content: ' end' },
    ]);
    expect(roleplayDocumentPlainText(resolved.document)).toBe(
      'Before  middle  unknown  malformed  unclosed 中文保留 then failed  end',
    );
    expect(resolved.diagnostics.map((item) => item.code).sort()).toEqual([
      'scene_view_projection_failed',
      'scene_view_reference_duplicate',
      'scene_view_reference_malformed',
      'scene_view_reference_malformed',
      'scene_view_reference_unknown',
      'scene_view_unused',
    ].sort());
  });

  it('omits a projection whose props fail the manifest contract', async () => {
    const turn = workspace();
    const runtime = new SceneViewRuntime({
      scene: { id: randomUUID(), slug: 'test', version: '1.0.0', archiveDigest: 'b'.repeat(64) },
      declarations: [declaration],
      host: { call: async () => ({ props: { points: 'model-authored-invalid' } }) } as unknown as SceneModuleHost,
      setup: {}, playerProfile: undefined, workspace: turn,
    });
    const reference = await stage(runtime);
    const resolved = await runtime.resolve(`Prose ${reference} survives.`);
    expect(roleplayDocumentPlainText(resolved.document)).toBe('Prose  survives.');
    expect(resolved.document.blocks.some((block) => block.type === 'scene-view')).toBe(false);
    expect(resolved.diagnostics).toEqual([
      expect.objectContaining({ source: 'scene-view', code: 'scene_view_projection_failed', viewKind: 'combat' }),
    ]);
  });
});
