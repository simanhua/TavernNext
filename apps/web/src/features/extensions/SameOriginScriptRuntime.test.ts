// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import type { TrustedScriptManifest } from '@tavernnext/extension-runtime';
import { SameOriginScriptRuntimeFrame } from './SameOriginScriptRuntime.js';

afterEach(() => {
  document.body.replaceChildren();
  delete (window as unknown as Record<string, unknown>).runtimeStarted;
  delete (window as unknown as Record<string, unknown>).runtimeClicks;
});

function manifest(content: string): TrustedScriptManifest {
  return {
    conversationId: 'conversation-1', runtimeKey: 'runtime-1',
    scripts: [{ owner: { kind: 'preset', id: 'preset-1' }, ownerRevision: 1, bundleDigest: 'a'.repeat(64), id: 'preset:preset-1:script-1', sourceId: 'script-1', name: 'Synthetic', content, order: [0] }],
    buttons: [{ owner: { kind: 'preset', id: 'preset-1' }, scriptId: 'preset:preset-1:script-1', name: 'Run' }],
  };
}

describe('same-origin trusted script iframe', () => {
  it('provides parent access, lifecycle events, owning buttons, and not_supported globals', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const diagnostics: string[] = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, (diagnostic) => diagnostics.push(diagnostic.message));
    await runtime.start(manifest(`
      parent.runtimeStarted = (parent.runtimeStarted || 0) + 1;
      eventOn(getButtonEvent('Run'), () => { parent.runtimeClicks = (parent.runtimeClicks || 0) + 1; });
      TavernHelper.missingMethod().catch(error => { parent.unsupportedCode = error.code; });
    `));

    expect(mount.querySelector('iframe')?.hidden).toBe(true);
    expect((window as unknown as { runtimeStarted?: number }).runtimeStarted).toBe(1);
    await runtime.invoke('preset:preset-1:script-1', 'Run');
    expect((window as unknown as { runtimeClicks?: number }).runtimeClicks).toBe(1);
    await Promise.resolve();
    expect((window as unknown as { unsupportedCode?: string }).unsupportedCode).toBe('not_supported');
    expect(diagnostics).toEqual([]);

    runtime.destroy();
    expect(mount.querySelector('iframe')).toBeNull();
  });

  it('bridges supported globals with the owning runtime identity', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const calls: unknown[] = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, () => undefined, async (input) => {
      calls.push(input);
      return [{ message_id: 0, message: 'Persisted' }];
    });
    await runtime.start(manifest(`
      eventOn(getButtonEvent('Run'), async () => { parent.bridgedMessages = await getChatMessages(); });
    `));

    await runtime.invoke('preset:preset-1:script-1', 'Run');

    expect((window as unknown as { bridgedMessages?: unknown }).bridgedMessages).toEqual([{ message_id: 0, message: 'Persisted' }]);
    expect(calls).toEqual([expect.objectContaining({
      conversationId: 'conversation-1', scriptId: 'script-1', method: 'getChatMessages', ownerKind: 'preset', ownerId: 'preset-1',
    })]);
  });

  it('lets a synthetic lifecycle script persist messages and variables observed after reload', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const persisted = { messages: [{ message_id: 0, message: 'Before' }], variables: {} as Record<string, unknown> };
    const caller = async (input: { method: string; args: unknown[] }) => {
      if (input.method === 'setChatMessages') {
        persisted.messages = structuredClone(input.args[0] as typeof persisted.messages);
        return persisted.messages;
      }
      if (input.method === 'replaceVariables') {
        persisted.variables = structuredClone(input.args[0] as Record<string, unknown>);
        return { value: persisted.variables };
      }
      if (input.method === 'getChatMessages') return structuredClone(persisted.messages);
      if (input.method === 'getVariables') return { value: structuredClone(persisted.variables) };
      throw new Error('unexpected method');
    };
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, () => undefined, caller);
    await runtime.start(manifest(`
      eventOn(event_types.APP_READY, async () => {
        await setChatMessages([{ message_id: 0, message: 'After' }]);
        await replaceVariables({ phase: 'saved' });
      });
    `));
    runtime.destroy();

    const reloaded = new SameOriginScriptRuntimeFrame(document, mount, () => undefined, caller);
    await reloaded.start(manifest(`
      eventOn(event_types.APP_READY, async () => {
        parent.reloadedState = { messages: await getChatMessages(), variables: await getVariables() };
      });
    `));

    expect((window as unknown as { reloadedState?: unknown }).reloadedState).toEqual({
      messages: [{ message_id: 0, message: 'After' }],
      variables: { value: { phase: 'saved' } },
    });
  });

  it('propagates message-event floor context to getMessageId RPC calls', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const calls: Array<{ currentMessageId?: number }> = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, () => undefined, async (input) => {
      calls.push(input);
      return input.currentMessageId;
    });
    await runtime.start(manifest(`
      eventOn('synthetic-message-event', async () => { parent.currentFloor = await getMessageId(); });
      parent.currentFloorPromise = eventEmitAndWait('synthetic-message-event', { message_id: 3 });
    `));
    await (window as unknown as { currentFloorPromise: Promise<unknown> }).currentFloorPromise;

    expect((window as unknown as { currentFloor?: number }).currentFloor).toBe(3);
    expect(calls).toEqual([expect.objectContaining({ currentMessageId: 3 })]);
  });

  it('attributes lifecycle registrations and removes direct parent listeners on destroy', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const ownMethodsBefore = {
      windowAdd: Object.hasOwn(window, 'addEventListener'),
      documentAdd: Object.hasOwn(document, 'addEventListener'),
    };
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, () => undefined);
    await runtime.start(manifest(`
      parent.document.body.addEventListener('direct-parent-event', () => { parent.runtimeClicks = (parent.runtimeClicks || 0) + 1; });
      eventOn(event_types.APP_READY, async () => {
        await Promise.resolve();
        parent.lifecycleAfterAwaitId = getScriptId();
        eventOn(getButtonEvent('Run'), () => { parent.lifecycleScriptId = getScriptId(); });
      });
    `));

    document.body.dispatchEvent(new Event('direct-parent-event'));
    expect((window as unknown as { runtimeClicks?: number }).runtimeClicks).toBe(1);
    expect((window as unknown as { lifecycleAfterAwaitId?: string }).lifecycleAfterAwaitId).toBe('script-1');
    await runtime.invoke('preset:preset-1:script-1', 'Run');
    expect((window as unknown as { lifecycleScriptId?: string }).lifecycleScriptId).toBe('script-1');

    runtime.destroy();
    expect(Object.hasOwn(window, 'addEventListener')).toBe(ownMethodsBefore.windowAdd);
    expect(Object.hasOwn(document, 'addEventListener')).toBe(ownMethodsBefore.documentAdd);
    document.body.dispatchEvent(new Event('direct-parent-event'));
    expect((window as unknown as { runtimeClicks?: number }).runtimeClicks).toBe(1);
  });

  it('attributes an asynchronous parent event failure and disables its owner', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const diagnostics: string[] = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, (value) => diagnostics.push(value.scriptId));
    await runtime.start(manifest(`
      parent.addEventListener('explode-later', () => { throw new Error('async parent failure'); });
    `));

    window.dispatchEvent(new Event('explode-later'));
    await Promise.resolve();
    await Promise.resolve();

    expect(diagnostics).toEqual(['preset:preset-1:script-1']);
    expect(await runtime.invoke('preset:preset-1:script-1', 'Run')).toBe(false);
  });

  it('attributes an asynchronous iframe error by source and disables its owner', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const diagnostics: string[] = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, (value) => diagnostics.push(value.scriptId));
    await runtime.start(manifest(''));
    const error = new Error('timer failed');
    error.stack = 'Error: timer failed\n at tavernnext-runtime:preset:preset-1:script-1:1:1';

    mount.querySelector('iframe')?.contentWindow?.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

    expect(diagnostics).toEqual(['preset:preset-1:script-1']);
    expect(await runtime.invoke('preset:preset-1:script-1', 'Run')).toBe(false);
  });

  it('disables every ambiguous owner when cached modules share a failing source', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const diagnostics: string[] = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, (value) => diagnostics.push(value.scriptId));
    const cacheUrl = `/api/extension-trust/preset/preset-1/cache/${'f'.repeat(64)}`;
    const input = manifest(`// ${cacheUrl}`);
    input.scripts.push({
      ...input.scripts[0]!, id: 'preset:preset-1:script-2', sourceId: 'script-2', name: 'Second',
    });
    await runtime.start(input);
    const error = new Error('shared module failed');
    error.stack = `Error: shared module failed\n at ${cacheUrl}:1:1`;

    mount.querySelector('iframe')?.contentWindow?.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

    expect(diagnostics).toEqual(['preset:preset-1:script-1', 'preset:preset-1:script-2']);
  });

  it('disables a failing script for the current runtime and keeps the host alive', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const diagnostics: string[] = [];
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, (diagnostic) => diagnostics.push(diagnostic.scriptId));

    await runtime.start(manifest(`
      eventOn(getButtonEvent('Run'), () => { throw new Error('button failed'); });
    `));
    expect(await runtime.invoke('preset:preset-1:script-1', 'Run')).toBe(false);
    expect(await runtime.invoke('preset:preset-1:script-1', 'Run')).toBe(false);
    expect(diagnostics).toEqual(['preset:preset-1:script-1']);
    expect(mount.querySelector('iframe')).not.toBeNull();
  });

  it('cancels an in-flight module load when the runtime is destroyed', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const runtime = new SameOriginScriptRuntimeFrame(document, mount, () => undefined);

    const starting = runtime.start(manifest("import '/never-loads.js';"));
    runtime.destroy();
    await starting;

    expect(mount.querySelector('iframe')).toBeNull();
  });
});
