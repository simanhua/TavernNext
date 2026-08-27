// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  sceneVersion: '2.7.0',
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

function trustScene(value = block) {
  vi.spyOn(api, 'getScene').mockResolvedValue({
    id: value.sceneId,
    version: value.sceneVersion,
    archiveDigest: value.sceneDigest,
    fullyTrusted: true,
    manifest: {
      sceneViews: [{
        kind: value.kind, schemaVersion: value.schemaVersion,
        projection: { hook: 'projectSceneView', schema: { type: 'object' } },
        renderer: { id: value.rendererId },
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
    ['status', 'destined-poem-status-v1', {
      name: 'Aster', level: 4, rank: 'Silver', fate: 3,
      resources: { hp: 8, maxHp: 10, mp: 4, maxMp: 8, stamina: 6, maxStamina: 9 },
      attributes: { Strength: 2 }, statuses: ['Focused'],
    }, 'Aster status'],
    ['map', 'destined-poem-map-v1', {
      location: 'Vault', time: 'Dusk', markers: [{
        id: 'vault', name: 'Archive Vault', group: 'City', description: 'Sealed stacks', active: true,
      }],
    }, 'Vault map'],
    ['relationship', 'destined-poem-relationship-v1', {
      entries: [{ id: 'lyra', name: 'Lyra', affinity: 12, description: 'Trusted guide' }],
    }, 'Relationship view'],
    ['progress', 'destined-poem-progress-v1', {
      event: { title: 'Archive defense', stage: 'Aftermath' },
      quests: [{ id: 'guard', title: 'Guard the archive', status: 'completed', description: 'The vault is safe.' }],
      level: 4, experience: 90, nextExperience: 120,
    }, 'Progress view'],
  ] as const)('renders the reviewed %s renderer', async (kind, rendererId, props, label) => {
    const candidate = { ...block, kind, rendererId, props };
    trustScene(candidate);
    renderBlock(candidate);
    expect(await screen.findByRole('region', { name: label })).not.toBeNull();
  });

  it('renders status attributes as structured frontend content', async () => {
    const candidate = {
      ...block,
      kind: 'status',
      rendererId: 'destined-poem-status-v1',
      props: {
        name: '风信子', level: 1, rank: '未评级', fate: 0,
        resources: { hp: 10, maxHp: 10, mp: 6, maxMp: 6, stamina: 8, maxStamina: 8 },
        attributes: { 力量: 4, 敏捷: 5, 体质: 6, 智力: 3, 精神: 6 },
        statuses: [],
      },
    } satisfies RoleplaySceneViewBlock;
    trustScene(candidate);
    renderBlock(candidate);
    expect(await screen.findByRole('region', { name: '风信子 status' })).not.toBeNull();
    for (const [name, value] of [['力量', 4], ['敏捷', 5], ['体质', 6], ['智力', 3], ['精神', 6]] as const) {
      const attribute = screen.getByRole('group', { name: `${name} attribute` });
      expect(within(attribute).getByText(name)).not.toBeNull();
      expect(within(attribute).getByText(String(value))).not.toBeNull();
    }
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
