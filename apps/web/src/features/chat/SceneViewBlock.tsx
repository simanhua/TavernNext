import type { RoleplaySceneViewBlock, SceneFrontendModule } from '@tavernnext/domain';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';

export type SceneViewModuleLoader = (entryUrl: string) => Promise<Partial<SceneFrontendModule>>;

const defaultLoadModule: SceneViewModuleLoader = async (entryUrl) => (
  import(/* @vite-ignore */ entryUrl) as Promise<Partial<SceneFrontendModule>>
);

function fallbackText(block: RoleplaySceneViewBlock): string {
  return `此场景视图由旧版本生成，当前版本无法显示（${block.kind}）。`;
}

export function SceneViewBlock({
  block,
  loadModule = defaultLoadModule,
}: {
  block: RoleplaySceneViewBlock;
  loadModule?: SceneViewModuleLoader;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const scene = useQuery({
    queryKey: ['scene-view-trust', block.sceneId],
    queryFn: () => api.getScene(block.sceneId),
    staleTime: 60_000,
  });
  const declaration = scene.data?.manifest.sceneViews.find((view) => (
    view.kind === block.kind
    && view.schemaVersion === block.schemaVersion
    && view.renderer.id === block.rendererId
  ));
  const compatible = scene.data?.fullyTrusted === true
    && scene.data.id === block.sceneId
    && declaration !== undefined;

  useEffect(() => {
    const installed = scene.data;
    const host = hostRef.current;
    if (!compatible || installed === undefined || host === null) return;
    let cancelled = false;
    let cleanup: (() => void | Promise<void>) | undefined;
    setRenderFailed(false);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    for (const path of installed.manifest.frontendStyles ?? []) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/api/scenes/${encodeURIComponent(block.sceneId)}/assets/${path}?digest=${installed.archiveDigest}`;
      shadow.append(link);
    }
    const root = document.createElement('div');
    root.dataset.sceneViewRoot = '';
    shadow.append(root);
    if (typeof installed.manifest.frontendEntry !== 'string') {
      setRenderFailed(true);
      return;
    }
    const entryUrl = `/api/scenes/${encodeURIComponent(block.sceneId)}/assets/${installed.manifest.frontendEntry}?digest=${installed.archiveDigest}`;
    void loadModule(entryUrl).then(async (module) => {
      if (typeof module.renderSceneView !== 'function') throw new Error('scene_view_renderer_missing');
      const result = await module.renderSceneView({ root, block: structuredClone(block) });
      if (typeof result === 'function') {
        if (cancelled) await result();
        else cleanup = result;
      }
    }).catch(() => {
      if (!cancelled) setRenderFailed(true);
    });
    return () => {
      cancelled = true;
      void cleanup?.();
      shadow.replaceChildren();
    };
  }, [block, compatible, loadModule, scene.data]);

  if (!scene.isLoading && (!compatible || renderFailed)) {
    return <span className="scene-view-fallback" data-scene-view-id={block.viewId}>{fallbackText(block)}</span>;
  }
  return <span ref={hostRef} data-scene-view-host="" data-scene-view-id={block.viewId} />;
}
