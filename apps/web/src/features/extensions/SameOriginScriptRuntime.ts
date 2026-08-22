import {
  TAVERN_HELPER_BRIDGED_METHODS,
  type ExtensionRuntimeRpcRequest,
  type TrustedScriptManifest,
} from '@tavernnext/extension-runtime';
import {
  ScriptCompatibilityEnvironment,
  type RuntimeWindow,
  type ScriptRuntimeDiagnostic,
} from './ScriptCompatibilityEnvironment.js';
import { createExtensionRuntimeRpcClient, type RuntimeApiCaller } from './ExtensionRuntimeRpcClient.js';
export type { RuntimeApiCaller } from './ExtensionRuntimeRpcClient.js';

export type { ScriptRuntimeDiagnostic } from './ScriptCompatibilityEnvironment.js';
export interface ScriptRuntimeFrame {
  start(manifest: TrustedScriptManifest): Promise<void>;
  invoke(scriptId: string, name: string): Promise<boolean>;
  destroy(): void;
}

export class SameOriginScriptRuntimeFrame implements ScriptRuntimeFrame {
  private iframe?: HTMLIFrameElement;
  private runtimeWindow?: RuntimeWindow;
  private manifest?: TrustedScriptManifest;
  private pendingLoads = new Set<() => void>();
  private readonly environment: ScriptCompatibilityEnvironment;
  private readonly runtimeCaller: (scriptId: string, method: string, args: unknown[], currentMessageId?: number) => Promise<unknown>;

  constructor(
    document: Document,
    private readonly mount: HTMLElement,
    onDiagnostic: (value: ScriptRuntimeDiagnostic) => void,
    callApi?: RuntimeApiCaller,
  ) {
    this.document = document;
    const caller = callApi ?? createExtensionRuntimeRpcClient(fetch, (input) => {
      this.document.defaultView?.dispatchEvent(new CustomEvent('tavernnext:runtime-mutated', { detail: input }));
    });
    this.runtimeCaller = async (scriptId, method, args, currentMessageId) => {
      const script = this.manifest?.scripts.find((candidate) => candidate.id === scriptId);
      if (script === undefined || this.manifest === undefined) throw Object.assign(new Error('runtime_not_authorized'), { code: 'runtime_not_authorized' });
      const value = await caller({
        conversationId: this.manifest.conversationId,
        scriptId: script.sourceId,
        method: method as ExtensionRuntimeRpcRequest['method'],
        args,
        ownerKind: script.owner.kind,
        ownerId: script.owner.id,
        ownerRevision: script.ownerRevision,
        bundleDigest: script.bundleDigest,
        currentMessageId,
      });
      return value;
    };
    this.environment = new ScriptCompatibilityEnvironment(document, onDiagnostic, (scriptId, method, args) => (
      this.runtimeCaller(scriptId, method, args, this.environment.getCurrentMessageId())
    ));
  }
  private readonly document: Document;

  async start(manifest: TrustedScriptManifest): Promise<void> {
    this.destroy();
    this.manifest = manifest;
    const iframe = this.document.createElement('iframe');
    iframe.hidden = true;
    iframe.title = 'Trusted extension runtime';
    iframe.src = 'about:blank';
    this.mount.append(iframe);
    this.iframe = iframe;
    const runtimeWindow = iframe.contentWindow as RuntimeWindow | null;
    const runtimeDocument = iframe.contentDocument;
    if (runtimeWindow === null || runtimeDocument === null) throw new Error('runtime_frame_unavailable');
    this.runtimeWindow = runtimeWindow;
    runtimeDocument.open();
    runtimeDocument.write('<!doctype html><html><head></head><body></body></html>');
    runtimeDocument.close();
    this.environment.configure(manifest.scripts);
    this.environment.install(runtimeWindow);

    for (const script of manifest.scripts) {
      if (this.environment.isDisabled(script.id)) continue;
      this.environment.activate(script.id);
      try {
        if (/^\s*(?:import|export)\s/m.test(script.content)) {
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (cause?: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              this.pendingLoads.delete(finish);
              if (cause !== undefined) this.environment.disable(script.id, cause);
              resolve();
            };
            const element = runtimeDocument.createElement('script');
            element.type = 'module';
            element.dataset.scriptId = script.id;
            element.textContent = `${script.content}\n//# sourceURL=tavernnext-runtime:${script.id}`;
            element.onload = () => finish();
            element.onerror = () => finish(new Error('script_load_failed'));
            const timeout = setTimeout(() => finish(new Error('script_load_timeout')), 10_000);
            this.pendingLoads.add(finish);
            runtimeDocument.body.append(element);
          });
          if (this.iframe !== iframe) return;
        } else {
          const names = [
            'window', 'self', 'globalThis', 'parent', 'document', 'eventOn', 'eventOnce', 'eventEmit',
            'eventEmitAndWait', 'eventRemoveListener', 'eventClearEvent', 'eventClearAll', 'getScriptId',
            'getButtonEvent', 'event_types', 'TavernHelper', 'tavernHelper', 'TavernNext',
            'getTavernHelperVersion', 'getTavernVersion',
            ...TAVERN_HELPER_BRIDGED_METHODS,
          ];
          const values = names.map((name) => name === 'window' || name === 'self' || name === 'globalThis'
            ? runtimeWindow
            : name === 'parent' ? this.document.defaultView ?? runtimeWindow.parent
              : name === 'document' ? runtimeDocument : runtimeWindow[name]);
          const execute = runtimeWindow.Function(...names, `${script.content}\n//# sourceURL=tavernnext-runtime:${script.id}`);
          execute.call(runtimeWindow, ...values);
        }
      } catch (cause) {
        this.environment.disable(script.id, cause);
      }
    }
    this.environment.deactivate();
    await this.environment.emit('tavernnext:runtime:start', manifest);
  }

  invoke(scriptId: string, name: string): Promise<boolean> {
    return this.runtimeWindow === undefined ? Promise.resolve(false) : this.environment.invoke(scriptId, name);
  }

  destroy(): void {
    this.environment.destroy(this.manifest);
    this.manifest = undefined;
    for (const finish of [...this.pendingLoads]) finish();
    this.pendingLoads.clear();
    this.runtimeWindow = undefined;
    this.iframe?.remove();
    this.iframe = undefined;
  }
}
