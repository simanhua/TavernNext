import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTrustedScriptManifest,
  type TrustedScriptOwnerInput,
  type TrustedRuntimeButton,
} from '@tavernnext/extension-runtime';
import { api } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import {
  SameOriginScriptRuntimeFrame,
  type ScriptRuntimeDiagnostic,
  type ScriptRuntimeFrame,
} from './SameOriginScriptRuntime.js';
import { useActiveExtensionAssetCollections } from './useActiveExtensionAssetCollections.js';

export type ScriptRuntimeFrameFactory = (
  document: Document,
  mount: HTMLElement,
  onDiagnostic: (diagnostic: ScriptRuntimeDiagnostic) => void,
) => ScriptRuntimeFrame;

const defaultFactory: ScriptRuntimeFrameFactory = (document, mount, onDiagnostic) => (
  new SameOriginScriptRuntimeFrame(document, mount, onDiagnostic)
);

export function TrustedScriptRuntimeHost({
  conversationId,
  createFrame = defaultFactory,
}: {
  conversationId: string | null;
  createFrame?: ScriptRuntimeFrameFactory;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const active = useActiveExtensionAssetCollections(conversationId);
  const trustQueries = useQueries({
    queries: active.owners.map((owner) => ({
      queryKey: ['extension-trust', owner.kind, owner.id, owner.revision],
      queryFn: () => api.getExtensionTrust(owner.kind, owner.id),
    })),
  });
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ScriptRuntimeFrame | undefined>(undefined);
  const runtimeReadyRef = useRef<Promise<void>>(Promise.resolve());
  const [diagnostics, setDiagnostics] = useState<ScriptRuntimeDiagnostic[]>([]);
  const [buttons, setButtons] = useState<TrustedRuntimeButton[]>([]);
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['active-resource-context'] });
      void queryClient.invalidateQueries({ queryKey: ['extension-assets'] });
      void queryClient.invalidateQueries({ queryKey: ['extension-trust'] });
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
    };
    window.addEventListener('tavernnext:runtime-mutated', refresh);
    return () => window.removeEventListener('tavernnext:runtime-mutated', refresh);
  }, [conversationId, queryClient]);
  const inputs = active.owners.flatMap((owner, index): TrustedScriptOwnerInput[] => {
    const collection = active.assetQueries[index]?.data;
    const trust = trustQueries[index]?.data;
    if (collection === undefined || trust === undefined) return [];
    return [{
      owner: { kind: owner.kind, id: owner.id },
      revision: owner.revision,
      bundleDigest: trust.bundleDigest,
      trusted: trust.trusted,
      assets: collection.assets,
      remoteEntries: trust.remotes.flatMap((remote) => remote.sha256 === null ? [] : [{
        url: remote.url, sha256: remote.sha256,
      }]),
    }];
  });
  const inputsKey = JSON.stringify(inputs);
  const manifest = useMemo(() => buildTrustedScriptManifest(conversationId ?? 'none', {
    preset: conversationId === null ? undefined : inputs.find(({ owner }) => owner.kind === 'preset'),
    character: conversationId === null ? undefined : inputs.find(({ owner }) => owner.kind === 'character'),
  }), [conversationId, inputsKey]);

  useEffect(() => {
    setButtons(manifest.buttons);
    const replace = (event: Event) => {
      const detail = (event as CustomEvent<{ scriptId?: unknown; buttons?: unknown }>).detail;
      if (typeof detail?.scriptId !== 'string' || !Array.isArray(detail.buttons)) return;
      const script = manifest.scripts.find(({ id }) => id === detail.scriptId);
      if (script === undefined) return;
      const replacements = detail.buttons.flatMap((candidate): TrustedRuntimeButton[] => {
        const item = typeof candidate === 'object' && candidate !== null ? candidate as Record<string, unknown> : undefined;
        return typeof item?.name === 'string' && item.visible !== false
          ? [{ owner: script.owner, scriptId: script.id, name: item.name }]
          : [];
      });
      setButtons((current) => [
        ...current.filter((button) => button.scriptId !== script.id),
        ...replacements,
      ]);
    };
    window.addEventListener('tavernnext:script-buttons-changed', replace);
    return () => window.removeEventListener('tavernnext:script-buttons-changed', replace);
  }, [manifest.runtimeKey]);

  useEffect(() => {
    runtimeRef.current?.destroy();
    runtimeRef.current = undefined;
    setDiagnostics([]);
    if (conversationId === null || manifest.scripts.length === 0 || mountRef.current === null) return;
    let runtime: ScriptRuntimeFrame | undefined;
    runtime = createFrame(document, mountRef.current, (diagnostic) => {
      if (runtimeRef.current === runtime) setDiagnostics((current) => [...current, diagnostic]);
    });
    runtimeRef.current = runtime;
    runtimeReadyRef.current = runtime.start(manifest);
    void runtimeReadyRef.current.catch((cause) => {
      if (runtimeRef.current === runtime) setDiagnostics((current) => [...current, {
        scriptId: 'runtime', scriptName: 'Runtime', message: cause instanceof Error ? cause.message : String(cause),
      }]);
    });
    return () => {
      runtime.destroy();
      runtimeReadyRef.current = Promise.resolve();
      if (runtimeRef.current === runtime) runtimeRef.current = undefined;
    };
  }, [conversationId, createFrame, manifest.runtimeKey]);

  const disabled = new Set(diagnostics.map((diagnostic) => diagnostic.scriptId));
  return (
    <section className="trusted-script-runtime" aria-label={t('Trusted script runtime')}>
      <div ref={mountRef} />
      {buttons.length === 0 ? null : (
        <div className="editor-actions" aria-label={t('Script buttons')}>
          {buttons.map((button) => (
            <button
              type="button"
              key={`${button.owner.kind}:${button.owner.id}:${button.scriptId}:${button.name}`}
              disabled={disabled.has(button.scriptId)}
              onClick={() => { void runtimeRef.current?.invoke(button.scriptId, button.name); }}
            >{button.name}</button>
          ))}
        </div>
      )}
      {diagnostics.map((diagnostic, index) => (
        <p role="alert" key={`${diagnostic.scriptId}:${index}`}>
          {t('Trusted script failed open: {{script}} — {{error}}', {
            script: diagnostic.scriptName,
            error: diagnostic.message,
          })}
        </p>
      ))}
    </section>
  );
}
