import {
  TAVERN_HELPER_BRIDGED_METHODS,
  type TrustedRuntimeScript,
  type TrustedScriptManifest,
} from '@tavernnext/extension-runtime';

export interface ScriptRuntimeDiagnostic { scriptId: string; scriptName: string; message: string }
export type RuntimeWindow = Window & typeof globalThis & Record<string, unknown>;
interface RuntimeListener { scriptId: string; callback: (...args: unknown[]) => unknown; once: boolean }
interface ParentListenerRecord {
  target: EventTarget; type: string; original: EventListenerOrEventListenerObject;
  wrapped: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions;
  remove: EventTarget['removeEventListener'];
}
const buttonEvent = (scriptId: string, name: string) => `tavernnext:script-button:${scriptId}:${name}`;

export class ScriptCompatibilityEnvironment {
  private listeners = new Map<string, Set<RuntimeListener>>();
  private disabledScripts = new Set<string>();
  private scripts = new Map<string, TrustedRuntimeScript>();
  private activeScriptId = '';
  private activeSourceId = '';
  private currentMessageId?: number;
  private parentListeners: ParentListenerRecord[] = [];
  private restoreParentTargets: Array<() => void> = [];
  private sourceOwners = new Map<string, Set<string>>();

  constructor(
    private readonly document: Document,
    private readonly onDiagnostic: (value: ScriptRuntimeDiagnostic) => void,
    private readonly callApi: (scriptId: string, method: string, args: unknown[]) => Promise<unknown>,
  ) {}

  configure(scripts: TrustedRuntimeScript[]): void {
    this.scripts = new Map(scripts.map((script) => [script.id, script]));
    this.sourceOwners = new Map();
    for (const script of scripts) for (const match of script.content.matchAll(/\/api\/extension-trust\/[^"'\s)]+\/cache\/[a-f0-9]{64}/g)) {
      const owners = this.sourceOwners.get(match[0]) ?? new Set<string>();
      owners.add(script.id); this.sourceOwners.set(match[0], owners);
    }
  }

  activate(scriptId: string): void {
    this.activeScriptId = scriptId;
    this.activeSourceId = this.scripts.get(scriptId)?.sourceId ?? '';
  }
  deactivate(): void { this.activeScriptId = ''; this.activeSourceId = ''; }
  isDisabled(scriptId: string): boolean { return this.disabledScripts.has(scriptId); }
  getCurrentMessageId(): number | undefined { return this.currentMessageId; }

  disable(scriptId: string, cause: unknown): void {
    if (this.disabledScripts.has(scriptId)) return;
    this.disabledScripts.add(scriptId);
    const script = this.scripts.get(scriptId);
    this.onDiagnostic({
      scriptId, scriptName: script?.name ?? scriptId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    for (const [event, values] of this.listeners) {
      const retained = new Set([...values].filter((listener) => listener.scriptId !== scriptId));
      if (retained.size === 0) this.listeners.delete(event); else this.listeners.set(event, retained);
    }
  }

  private attributedScriptIds(value: unknown): Set<string> {
    const text = value instanceof Error ? `${value.stack ?? ''}\n${value.message}` : String(value ?? '');
    for (const id of this.scripts.keys()) if (text.includes(`tavernnext-runtime:${id}`)) return new Set([id]);
    const matches = new Set<string>();
    for (const [source, owners] of this.sourceOwners) if (text.includes(source)) for (const id of owners) matches.add(id);
    if (matches.size > 0) return matches;
    return this.activeScriptId === '' ? matches : new Set([this.activeScriptId]);
  }

  private attributedScriptId(value: unknown): string {
    const matches = this.attributedScriptIds(value);
    return matches.size === 1 ? [...matches][0]! : '';
  }

  private disableAttributed(cause: unknown): void {
    const matches = this.attributedScriptIds(cause);
    const targets = matches.size > 0 ? matches : new Set(this.scripts.keys());
    for (const id of targets) this.disable(id, matches.size > 0 ? cause : new Error(`Unattributed runtime failure: ${String(cause)}`));
  }

  private async withScript<T>(scriptId: string, callback: () => T | PromiseLike<T>): Promise<T> {
    const priorId = this.activeScriptId;
    const priorSourceId = this.activeSourceId;
    this.activate(scriptId);
    try { return await callback(); }
    finally { this.activeScriptId = priorId; this.activeSourceId = priorSourceId; }
  }

  private patchParentEventTargets(parentWindow: Window): void {
    type MutableTarget = { addEventListener: EventTarget['addEventListener']; removeEventListener: EventTarget['removeEventListener'] };
    const mutables = [
      (parentWindow as Window & typeof globalThis).EventTarget.prototype as MutableTarget,
      parentWindow as unknown as MutableTarget,
      parentWindow.document as unknown as MutableTarget,
    ];
    for (const mutable of mutables) {
      const add = mutable.addEventListener;
      const remove = mutable.removeEventListener;
      const addDescriptor = Object.getOwnPropertyDescriptor(mutable, 'addEventListener');
      const removeDescriptor = Object.getOwnPropertyDescriptor(mutable, 'removeEventListener');
      const environment = this;
      mutable.addEventListener = function (this: EventTarget, type, listener, options) {
        if (listener === null) return;
        const target = this;
        const scriptId = environment.attributedScriptId(new Error());
        if (scriptId === '') { add.call(target, type, listener, options); return; }
        const wrapped: EventListenerOrEventListenerObject = typeof listener === 'function'
          ? (event: Event) => {
            if (environment.isDisabled(scriptId)) return;
            void environment.withScript(scriptId, () => listener.call(target, event)).catch((cause) => environment.disable(scriptId, cause));
          }
          : { handleEvent: (event: Event) => {
            if (environment.isDisabled(scriptId)) return;
            void environment.withScript(scriptId, () => listener.handleEvent(event)).catch((cause) => environment.disable(scriptId, cause));
          } };
        environment.parentListeners.push({ target, type, original: listener, wrapped, options, remove });
        add.call(target, type, wrapped, options);
      } as EventTarget['addEventListener'];
      mutable.removeEventListener = function (this: EventTarget, type, listener, options) {
        const target = this;
        const match = environment.parentListeners.find((item) => item.target === target && item.type === type && item.original === listener);
        remove.call(target, type, match?.wrapped ?? listener, options);
        if (match !== undefined) environment.parentListeners = environment.parentListeners.filter((item) => item !== match);
      } as EventTarget['removeEventListener'];
      this.restoreParentTargets.push(() => {
        if (addDescriptor === undefined) Reflect.deleteProperty(mutable, 'addEventListener');
        else Object.defineProperty(mutable, 'addEventListener', addDescriptor);
        if (removeDescriptor === undefined) Reflect.deleteProperty(mutable, 'removeEventListener');
        else Object.defineProperty(mutable, 'removeEventListener', removeDescriptor);
      });
    }
  }

  async emit(event: string, ...args: unknown[]): Promise<boolean> {
    let ok = true;
    const priorMessageId = this.currentMessageId;
    const context = typeof args[0] === 'object' && args[0] !== null ? args[0] as Record<string, unknown> : undefined;
    if (Number.isInteger(context?.message_id)) this.currentMessageId = context!.message_id as number;
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      if (this.isDisabled(listener.scriptId)) continue;
      try { await this.withScript(listener.scriptId, () => listener.callback(...args)); }
      catch (cause) { ok = false; this.disable(listener.scriptId, cause); }
      if (listener.once) this.listeners.get(event)?.delete(listener);
    }
    this.currentMessageId = priorMessageId;
    return ok;
  }

  install(runtimeWindow: RuntimeWindow): void {
    const add = (event: string, callback: (...args: unknown[]) => unknown, once: boolean) => {
      const listener = { scriptId: this.activeScriptId, callback, once };
      const values = this.listeners.get(event) ?? new Set<RuntimeListener>();
      values.add(listener); this.listeners.set(event, values); return callback;
    };
    runtimeWindow.eventOn = (event: string, callback: (...args: unknown[]) => unknown) => add(event, callback, false);
    runtimeWindow.eventOnce = (event: string, callback: (...args: unknown[]) => unknown) => add(event, callback, true);
    runtimeWindow.eventEmit = (event: string, ...args: unknown[]) => this.emit(event, ...args);
    runtimeWindow.eventEmitAndWait = runtimeWindow.eventEmit;
    runtimeWindow.eventRemoveListener = (event: string, callback: (...args: unknown[]) => unknown) => {
      for (const listener of this.listeners.get(event) ?? []) if (listener.callback === callback) this.listeners.get(event)?.delete(listener);
    };
    runtimeWindow.eventClearEvent = (event: string) => this.listeners.delete(event);
    runtimeWindow.eventClearAll = () => this.listeners.clear();
    runtimeWindow.getScriptId = () => this.activeSourceId;
    runtimeWindow.getButtonEvent = (first: string, second?: string) => second === undefined ? buttonEvent(this.activeScriptId, first) : buttonEvent(first, second);
    runtimeWindow.event_types = Object.freeze({ APP_READY: 'tavernnext:runtime:start', CHAT_CHANGED: 'tavernnext:conversation:changed', RUNTIME_STOP: 'tavernnext:runtime:stop' });
    const unsupported = (method: PropertyKey) => async () => { throw Object.assign(new Error(`${String(method)} is not supported`), { code: 'not_supported' }); };
    const bridged = new Set<string>(TAVERN_HELPER_BRIDGED_METHODS);
    const bridge = (method: string) => (...args: unknown[]) => this.callApi(this.activeScriptId, method, args);
    const api = new Proxy({}, { get: (_target, method) => (
      typeof method === 'string' && bridged.has(method) ? bridge(method) : unsupported(method)
    ) });
    runtimeWindow.TavernHelper = api; runtimeWindow.tavernHelper = api;
    runtimeWindow.TavernNext = Object.freeze({ call: (method: string) => unsupported(method)() });
    runtimeWindow.getTavernHelperVersion = () => 'compat-0'; runtimeWindow.getTavernVersion = () => '1.18.0-compat';
    for (const method of TAVERN_HELPER_BRIDGED_METHODS) runtimeWindow[method] = bridge(method);
    runtimeWindow.addEventListener('error', (event: ErrorEvent) => this.disableAttributed(event.error ?? event.filename ?? new Error(event.message)));
    runtimeWindow.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => this.disableAttributed(event.reason));
    if (this.document.defaultView !== null) this.patchParentEventTargets(this.document.defaultView);
  }

  invoke(scriptId: string, name: string): Promise<boolean> {
    return this.isDisabled(scriptId) ? Promise.resolve(false) : this.emit(buttonEvent(scriptId, name));
  }

  destroy(manifest?: TrustedScriptManifest): void {
    if (manifest !== undefined) void this.emit('tavernnext:runtime:stop', manifest);
    this.listeners.clear();
    for (const item of this.parentListeners) item.remove.call(item.target, item.type, item.wrapped, item.options);
    this.parentListeners = [];
    for (const restore of this.restoreParentTargets.reverse()) restore();
    this.restoreParentTargets = [];
    this.disabledScripts.clear(); this.scripts.clear(); this.sourceOwners.clear(); this.deactivate();
    this.currentMessageId = undefined;
  }
}
