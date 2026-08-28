// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import type { RoleplaySceneViewBlock, SceneFrontendModule } from '@tavernnext/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client.js';
import { SceneViewBlock, type SceneViewModuleLoader } from './SceneViewBlock.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const block: RoleplaySceneViewBlock = {
  type: 'scene-view',
  viewId: '018f0000-0000-7000-8000-000000000451',
  sceneId: '018f2000-0000-7000-8000-000000000002',
  sceneVersion: '0.9.0',
  sceneDigest: 'a'.repeat(64),
  kind: 'status',
  schemaVersion: 1,
  rendererId: 'scene-lab-status-v1',
  sourceStateRevision: 7,
  props: { experimentName: 'Signal test', phase: 'observing', signal: 3 },
};

function trustScene(value = block, declarations = true) {
  vi.spyOn(api, 'getScene').mockResolvedValue({
    id: value.sceneId,
    version: '1.0.0',
    archiveDigest: 'b'.repeat(64),
    fullyTrusted: true,
    manifest: {
      frontendEntry: 'frontend/app.js',
      frontendStyles: ['frontend/styles.css'],
      sceneViews: declarations ? [{
        kind: value.kind,
        schemaVersion: value.schemaVersion,
        projection: { hook: 'projectSceneView', schema: { type: 'object' } },
        renderer: { id: value.rendererId },
      }] : [],
    },
  } as unknown as Awaited<ReturnType<typeof api.getScene>>);
}

function renderBlock(value: RoleplaySceneViewBlock, loadModule: SceneViewModuleLoader) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <SceneViewBlock block={value} loadModule={loadModule} />
  </QueryClientProvider>);
}

describe('SceneViewBlock package renderer dispatch', () => {
  it('renders a compatible historical block with the current trusted Scene module inside Shadow DOM', async () => {
    trustScene();
    const cleanupRenderer = vi.fn();
    const module: Partial<SceneFrontendModule> = {
      renderSceneView({ root, block: value }) {
        const region = document.createElement('section');
        region.setAttribute('role', 'region');
        region.setAttribute('aria-label', String(value.props.experimentName));
        region.textContent = `Signal ${String(value.props.signal)}`;
        root.append(region);
        return cleanupRenderer;
      },
    };
    const loadModule = vi.fn(async () => module);
    const rendered = renderBlock(block, loadModule);

    const host = await waitFor(() => {
      const value = rendered.container.querySelector<HTMLElement>('[data-scene-view-host]');
      if (value?.shadowRoot === null || value === null) throw new Error('shadow root not ready');
      return value;
    });
    expect(within(host.shadowRoot as unknown as HTMLElement).getByRole('region', { name: 'Signal test' })).not.toBeNull();
    expect(host.shadowRoot?.querySelector('link')?.getAttribute('href')).toContain('frontend/styles.css');
    expect(loadModule).toHaveBeenCalledWith(expect.stringContaining('/frontend/app.js?digest='));

    rendered.unmount();
    expect(cleanupRenderer).toHaveBeenCalledOnce();
  });

  it('falls back to fixed text when the installed Scene no longer declares the historical renderer', async () => {
    trustScene(block, false);
    const loadModule = vi.fn(async () => ({}));
    const rendered = renderBlock(block, loadModule);

    expect(await within(rendered.container).findByText('此场景视图由旧版本生成，当前版本无法显示（status）。')).not.toBeNull();
    expect(loadModule).not.toHaveBeenCalled();
  });
});
