import {
  MUTATING_TAVERN_HELPER_METHODS,
  applySPresetPromptHook,
  TAVERN_HELPER_BRIDGED_METHODS,
  type TrustedRuntimeScript,
  type TrustedScriptManifest,
} from '@tavernnext/extension-runtime';
import * as Vue from 'vue';
import * as Zod from 'zod';
import * as Lodash from 'lodash-es';

export interface ScriptRuntimeDiagnostic { scriptId: string; scriptName: string; message: string }
export type RuntimeWindow = Window & typeof globalThis & Record<string, unknown>;
interface RuntimeListener { scriptId: string; callback: (...args: unknown[]) => unknown; once: boolean; readOnly: boolean }
interface RuntimeScriptButton { name: string; visible: boolean }
interface ParentListenerRecord {
  target: EventTarget; type: string; original: EventListenerOrEventListenerObject;
  wrapped: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions; readOnly: boolean;
  remove: EventTarget['removeEventListener'];
}
const buttonEvent = (scriptId: string, name: string) => `tavernnext:script-button:${scriptId}:${name}`;
const promptEvents = new Set([
  'tavernnext:chat-completion-prompt-ready',
  'tavernnext:generate-after-combine-prompts',
  'tavernnext:trusted-prompt-hook',
]);

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
  private promptHooks = new Set<symbol>();
  private promptOnlyScripts = new Set<string>();
  private runtimeWindow?: RuntimeWindow;
  private extensionSettings: Record<string, unknown> = {};
  private scriptButtons = new Map<string, RuntimeScriptButton[]>();

  constructor(
    private readonly document: Document,
    private readonly onDiagnostic: (value: ScriptRuntimeDiagnostic) => void,
    private readonly callApi: (scriptId: string, method: string, args: unknown[]) => Promise<unknown>,
  ) {}

  configure(scripts: TrustedRuntimeScript[], buttons: TrustedScriptManifest['buttons'] = []): void {
    this.scripts = new Map(scripts.map((script) => [script.id, script]));
    this.promptOnlyScripts.clear();
    this.scriptButtons = new Map(scripts.map((script) => [
      script.id,
      buttons.filter((button) => button.scriptId === script.id).map((button) => ({ name: button.name, visible: true })),
    ]));
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

  private async withScriptCapability<T>(
    scriptId: string,
    readOnly: boolean,
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    const hook = readOnly ? Symbol('prompt-origin') : undefined;
    if (hook !== undefined) this.promptHooks.add(hook);
    try { return await this.withScript(scriptId, callback); }
    finally { if (hook !== undefined) this.promptHooks.delete(hook); }
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
        const readOnly = environment.promptHooks.size > 0;
        const wrapped: EventListenerOrEventListenerObject = typeof listener === 'function'
          ? (event: Event) => {
            if (environment.isDisabled(scriptId)) return;
            void environment.withScriptCapability(scriptId, readOnly, () => listener.call(target, event))
              .catch((cause) => environment.disable(scriptId, cause));
          }
          : { handleEvent: (event: Event) => {
            if (environment.isDisabled(scriptId)) return;
            void environment.withScriptCapability(scriptId, readOnly, () => listener.handleEvent(event))
              .catch((cause) => environment.disable(scriptId, cause));
          } };
        environment.parentListeners.push({ target, type, original: listener, wrapped, options, readOnly, remove });
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
      try {
        const execution = this.withScriptCapability(listener.scriptId, listener.readOnly, () => listener.callback(...args));
        if (this.promptHooks.size === 0) await execution;
        else await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('prompt_listener_timeout')), 1_000);
          void execution.then(
            () => { clearTimeout(timeout); resolve(); },
            (cause) => { clearTimeout(timeout); reject(cause); },
          );
        });
      }
      catch (cause) { ok = false; this.disable(listener.scriptId, cause); }
      if (listener.once) this.listeners.get(event)?.delete(listener);
    }
    this.currentMessageId = priorMessageId;
    return ok;
  }

  install(runtimeWindow: RuntimeWindow): void {
    this.runtimeWindow = runtimeWindow;
    const scheduleTimeout = runtimeWindow.setTimeout.bind(runtimeWindow);
    runtimeWindow.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const readOnly = this.promptHooks.size > 0;
      if (!readOnly) {
        return scheduleTimeout(handler, timeout, ...args);
      }
      const scriptId = this.activeScriptId;
      return scheduleTimeout(() => {
        void this.withScriptCapability(scriptId, true, () => (
          typeof handler === 'function' ? handler(...args) : runtimeWindow.eval(String(handler))
        )).catch((cause) => this.disable(scriptId, cause));
      }, timeout);
    }) as typeof runtimeWindow.setTimeout;
    const scheduleInterval = runtimeWindow.setInterval.bind(runtimeWindow);
    runtimeWindow.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const readOnly = this.promptHooks.size > 0;
      if (!readOnly) return scheduleInterval(handler, timeout, ...args);
      const scriptId = this.activeScriptId;
      return scheduleInterval(() => {
        void this.withScriptCapability(scriptId, true, () => (
          typeof handler === 'function' ? handler(...args) : runtimeWindow.eval(String(handler))
        )).catch((cause) => this.disable(scriptId, cause));
      }, timeout);
    }) as typeof runtimeWindow.setInterval;
    const scheduleMicrotask = runtimeWindow.queueMicrotask.bind(runtimeWindow);
    runtimeWindow.queueMicrotask = (callback: VoidFunction) => {
      const readOnly = this.promptHooks.size > 0;
      if (!readOnly) { scheduleMicrotask(callback); return; }
      const scriptId = this.activeScriptId;
      scheduleMicrotask(() => {
        void this.withScriptCapability(scriptId, true, callback).catch((cause) => this.disable(scriptId, cause));
      });
    };
    if (typeof runtimeWindow.requestAnimationFrame === 'function') {
      const scheduleAnimation = runtimeWindow.requestAnimationFrame.bind(runtimeWindow);
      runtimeWindow.requestAnimationFrame = (callback: FrameRequestCallback) => {
        const readOnly = this.promptHooks.size > 0;
        if (!readOnly) return scheduleAnimation(callback);
        const scriptId = this.activeScriptId;
        return scheduleAnimation((time) => {
          void this.withScriptCapability(scriptId, true, () => callback(time))
            .catch((cause) => this.disable(scriptId, cause));
        });
      };
    }
    const parentDocument = this.document;
    const chatFacade = () => [...parentDocument.querySelectorAll('#chat .mes')].map((message) => ({
      is_user: message.classList.contains('message-user'),
      mes: message.querySelector('.mes_text')?.textContent ?? '',
      swipe_id: Number(message.getAttribute('data-swipe-id') ?? 0),
      extra: {
        reasoning: message.querySelector('.mes_reasoning')?.textContent ?? '',
        reasoning_state: 'done',
        reasoning_duration: 0,
      },
    }));
    const sillyTavernFacade = {
      get chat() { return chatFacade(); },
      extensionSettings: this.extensionSettings,
      getContext: () => ({
        extensionSettings: this.extensionSettings,
        powerUserSettings: { reasoning: {
          prefix: '<think>', suffix: '</think>', auto_parse: true, auto_expand: false,
        } },
      }),
      saveSettingsDebounced: () => undefined,
      updateMessageBlock: () => undefined,
    };
    runtimeWindow.SillyTavern = sillyTavernFacade;
    runtimeWindow.Vue = Vue;
    runtimeWindow.z = Zod;
    runtimeWindow._ = Lodash as unknown as typeof runtimeWindow._;
    runtimeWindow.tavern_events = Object.freeze({
      MESSAGE_UPDATED: 'tavernnext:message:updated', MESSAGE_RECEIVED: 'tavernnext:message:received',
      CHAT_CHANGED: 'tavernnext:conversation:changed', CHARACTER_MESSAGE_RENDERED: 'tavernnext:message:rendered',
      STREAM_TOKEN_RECEIVED: 'tavernnext:stream:token',
    });
    runtimeWindow.$ = (target: unknown) => {
      if (typeof target === 'function') { target(); return undefined; }
      return {
        on: (event: string, listener: EventListener) => (target as EventTarget | undefined)?.addEventListener?.(event, listener),
        off: (event: string, listener: EventListener) => (target as EventTarget | undefined)?.removeEventListener?.(event, listener),
      };
    };
    const add = (event: string, callback: (...args: unknown[]) => unknown, once: boolean) => {
      const scriptId = this.activeScriptId;
      if (promptEvents.has(event) && scriptId !== '') this.promptOnlyScripts.add(scriptId);
      const listener = { scriptId, callback, once, readOnly: this.promptHooks.size > 0 };
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
    runtimeWindow.getScriptButtons = () => structuredClone(this.scriptButtons.get(this.activeScriptId) ?? []);
    runtimeWindow.replaceScriptButtons = (value: unknown) => {
      if (!Array.isArray(value)) throw Object.assign(new Error('invalid_buttons'), { code: 'invalid_request' });
      const buttons = value.map((candidate) => {
        const item = typeof candidate === 'object' && candidate !== null ? candidate as Record<string, unknown> : undefined;
        if (typeof item?.name !== 'string' || item.name.trim() === '' || item.name.length > 256) {
          throw Object.assign(new Error('invalid_buttons'), { code: 'invalid_request' });
        }
        return { name: item.name, visible: item.visible !== false };
      });
      const scriptId = this.activeScriptId;
      if (scriptId === '') throw Object.assign(new Error('runtime_not_authorized'), { code: 'runtime_not_authorized' });
      this.scriptButtons.set(scriptId, structuredClone(buttons));
      this.document.defaultView?.dispatchEvent(new CustomEvent('tavernnext:script-buttons-changed', {
        detail: { scriptId, buttons: structuredClone(buttons) },
      }));
    };
    runtimeWindow.event_types = Object.freeze({
      APP_READY: 'tavernnext:runtime:start', CHAT_CHANGED: 'tavernnext:conversation:changed', RUNTIME_STOP: 'tavernnext:runtime:stop',
      CHAT_COMPLETION_PROMPT_READY: 'tavernnext:chat-completion-prompt-ready',
      GENERATE_AFTER_COMBINE_PROMPTS: 'tavernnext:generate-after-combine-prompts',
      TRUSTED_PROMPT_HOOK: 'tavernnext:trusted-prompt-hook',
    });
    const unsupported = (method: PropertyKey) => async () => { throw Object.assign(new Error(`${String(method)} is not supported`), { code: 'not_supported' }); };
    const bridged = new Set<string>(TAVERN_HELPER_BRIDGED_METHODS);
    const bridge = (method: string) => (...args: unknown[]) => {
      const scriptId = this.activeScriptId;
      if (scriptId === '' || this.disabledScripts.has(scriptId)) {
        return Promise.reject(Object.assign(new Error('runtime_disabled'), { code: 'runtime_disabled' }));
      }
      return (this.promptHooks.size > 0 || this.promptOnlyScripts.has(scriptId)) && MUTATING_TAVERN_HELPER_METHODS.has(method)
        ? Promise.resolve(undefined)
        : this.callApi(scriptId, method, args);
    };
    const api = new Proxy({}, { get: (_target, method) => (
      typeof method === 'string' && bridged.has(method) ? bridge(method) : unsupported(method)
    ) });
    runtimeWindow.TavernHelper = api; runtimeWindow.tavernHelper = api;
    runtimeWindow.TavernNext = Object.freeze({ call: (method: string) => unsupported(method)() });
    runtimeWindow.getTavernHelperVersion = () => 'compat-0'; runtimeWindow.getTavernVersion = () => '1.18.0-compat';
    runtimeWindow.waitGlobalInitialized = async () => undefined;
    for (const method of TAVERN_HELPER_BRIDGED_METHODS) runtimeWindow[method] = bridge(method);
    runtimeWindow.addEventListener('error', (event: ErrorEvent) => this.disableAttributed(event.error ?? event.filename ?? new Error(event.message)));
    runtimeWindow.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => this.disableAttributed(event.reason));
    if (this.document.defaultView !== null) this.patchParentEventTargets(this.document.defaultView);
  }

  invoke(scriptId: string, name: string): Promise<boolean> {
    return this.isDisabled(scriptId) ? Promise.resolve(false) : this.emit(buttonEvent(scriptId, name));
  }

  async runPromptHook(candidate: {
    kind: 'chat' | 'text'; messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>;
    text?: string; stop: string[]; spreset?: unknown;
  }, dryRun: boolean) {
    const transformed = applySPresetPromptHook(candidate, (source, content) => {
      if (this.runtimeWindow === undefined) return content;
      const execute = this.runtimeWindow.Function('content', `"use strict"; return (${source})(content);`);
      return execute(content) as unknown;
    });
    const patch = structuredClone({ messages: transformed.messages, text: transformed.text, stop: transformed.stop });
    const hook = Symbol('prompt-hook');
    this.promptHooks.add(hook);
    try {
      if (candidate.kind === 'chat') {
        const eventData = { chat: patch.messages!, stop: patch.stop, dryRun };
        await this.emit('tavernnext:chat-completion-prompt-ready', eventData);
        patch.messages = eventData.chat; patch.stop = eventData.stop;
      } else {
        const eventData = { prompt: patch.text!, stop: patch.stop, dryRun };
        await this.emit('tavernnext:generate-after-combine-prompts', eventData);
        patch.text = eventData.prompt; patch.stop = eventData.stop;
      }
      await this.emit('tavernnext:trusted-prompt-hook', { candidate: transformed, patch, dryRun });
      return patch;
    } finally {
      this.promptHooks.delete(hook);
    }
  }

  destroy(manifest?: TrustedScriptManifest): void {
    if (manifest !== undefined) void this.emit('tavernnext:runtime:stop', manifest);
    this.listeners.clear();
    for (const item of this.parentListeners) item.remove.call(item.target, item.type, item.wrapped, item.options);
    this.parentListeners = [];
    for (const restore of this.restoreParentTargets.reverse()) restore();
    this.restoreParentTargets = [];
    this.disabledScripts.clear(); this.scripts.clear(); this.sourceOwners.clear(); this.deactivate();
    this.scriptButtons.clear();
    this.currentMessageId = undefined;
    this.promptHooks.clear();
    this.promptOnlyScripts.clear();
    this.runtimeWindow = undefined;
  }
}
