// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { RoleplaySceneViewBlock } from '@tavernnext/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client.js';
import { SceneViewBlock } from './SceneViewBlock.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const block: RoleplaySceneViewBlock = {
  type: 'scene-view',
  viewId: '018f0000-0000-7000-8000-000000000451',
  sceneId: '018f2000-0000-7000-8000-000000000001',
  sceneVersion: '2.6.0',
  sceneDigest: 'a'.repeat(64),
  kind: 'combat',
  schemaVersion: 1,
  rendererId: 'destined-poem-combat-v1',
  sourceStateRevision: 7,
  props: {
    title: 'Archive battle', location: 'Vault',
    protagonist: { name: 'Aster', hp: 8, maxHp: 10, statuses: [] },
    opponents: [],
  },
};

function renderBlock(value: RoleplaySceneViewBlock) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SceneViewBlock block={value} /></QueryClientProvider>);
}

function trustScene() {
  vi.spyOn(api, 'getScene').mockResolvedValue({
    id: block.sceneId,
    version: block.sceneVersion,
    archiveDigest: block.sceneDigest,
    fullyTrusted: true,
    manifest: {
      sceneViews: [{
        kind: block.kind, schemaVersion: block.schemaVersion,
        projection: { hook: 'projectSceneView', schema: { type: 'object' } },
        renderer: { id: block.rendererId },
      }],
    },
  } as unknown as Awaited<ReturnType<typeof api.getScene>>);
}

describe('SceneViewBlock trust dispatch', () => {
  it('renders only after the complete persisted trust tuple matches the installed official Scene', async () => {
    trustScene();
    renderBlock(block);
    expect(await screen.findByRole('region', { name: 'Archive battle' })).not.toBeNull();
  });

  it.each([
    ['version', { ...block, sceneVersion: '9.9.9' }],
    ['digest', { ...block, sceneDigest: 'b'.repeat(64) }],
  ])('rejects a mismatched %s', async (_label, candidate) => {
    trustScene();
    renderBlock(candidate);
    await waitFor(() => expect(api.getScene).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Archive battle' })).toBeNull();
  });
});
