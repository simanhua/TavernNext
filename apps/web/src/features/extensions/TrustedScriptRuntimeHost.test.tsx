// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TrustedScriptManifest } from '@tavernnext/extension-runtime';
import { renderWithApp } from '../../test/render.js';
import type { ScriptRuntimeDiagnostic, ScriptRuntimeFrame } from './SameOriginScriptRuntime.js';
import { TrustedScriptRuntimeHost, type ScriptRuntimeFrameFactory } from './TrustedScriptRuntimeHost.js';
import { runTrustedPromptHooks } from './TrustedPromptHooks.js';

const presetId = '018f0000-0000-7000-8000-000000004001';
const characterId = '018f0000-0000-7000-8000-000000004002';
let presetDigest = 'a'.repeat(64);
let characterTrusted = true;

function asset(owner: 'preset' | 'character') {
  return {
    kind: 'tavern_helper', sourceKey: `${owner}-asset`, ordinal: 0, enabled: true, diagnostics: [],
    payload: {
      id: `${owner}-script`, type: 'script', name: `${owner} script`, enabled: true,
      content: '', button: { enabled: true, buttons: [{ name: `${owner} button`, visible: true }] },
    },
  };
}

const server = setupServer(
  http.get('/api/settings/generation', () => HttpResponse.json({ revision: 1 })),
  http.get('/api/settings/generation/active-resource-context', () => HttpResponse.json({
    globalGenerationConfigRevision: 1, mode: 'chat', conversation: { id: 'conversation-1', revision: 1 },
    primaryPreset: { id: presetId, revision: 1, name: 'Preset', kind: 'chat' },
    character: { id: characterId, revision: 1, name: 'Character' },
    owners: [
      { kind: 'preset', id: presetId, revision: 1, name: 'Preset' },
      { kind: 'character', id: characterId, revision: 1, name: 'Character' },
    ],
  })),
  http.get('/api/extension-assets', ({ request }) => {
    const kind = new URL(request.url).searchParams.get('ownerKind') as 'preset' | 'character';
    return HttpResponse.json({
      owner: { kind, id: kind === 'preset' ? presetId : characterId, revision: 1, name: kind },
      assets: [asset(kind)],
    });
  }),
  http.get('/api/extension-trust/:kind/:id', ({ params }) => {
    const preset = params.kind === 'preset';
    return HttpResponse.json({
      owner: { kind: params.kind, id: params.id }, scripts: [], remotes: [],
      bundleDigest: preset ? presetDigest : 'b'.repeat(64), trusted: preset || characterTrusted,
      sameOriginRisk: true, dynamicNetworkDisclaimer: '', auditEvents: [],
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); presetDigest = 'a'.repeat(64); characterTrusted = true; });
afterAll(() => server.close());

describe('TrustedScriptRuntimeHost', () => {
  it('runs a prompt hook without waiting for unrelated script startup to settle', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const hookCalls: number[] = [];
    const frames: ScriptRuntimeFrame[] = [];
    const createFrame: ScriptRuntimeFrameFactory = () => {
      const index = frames.length;
      const frame: ScriptRuntimeFrame = {
        start: async () => index === 0 ? firstReady : undefined,
        invoke: async () => true,
        runPromptHook: async (candidate) => {
          hookCalls.push(index);
          return { messages: candidate.messages, text: candidate.text, stop: candidate.stop };
        },
        destroy() {},
      };
      frames.push(frame);
      return frame;
    };
    renderWithApp(
      <TrustedScriptRuntimeHost conversationId="conversation-1" createFrame={createFrame} />,
    );
    await waitFor(() => expect(frames).toHaveLength(1));
    const hook = runTrustedPromptHooks({
      kind: 'chat', messages: [{ role: 'user', content: 'queued' }], stop: [],
    }, false);
    await Promise.resolve();
    await Promise.resolve();
    const callsBeforeFullStartup = [...hookCalls];
    releaseFirst?.();
    await expect(hook).resolves.toMatchObject({ messages: [{ role: 'user', content: 'queued' }] });
    expect(callsBeforeFullStartup).toEqual([0]);
    expect(hookCalls).toEqual([0]);
  });

  it('restarts on digest/trust changes, routes owning buttons, and surfaces fail-open errors', async () => {
    const frames: Array<ScriptRuntimeFrame & { manifest?: TrustedScriptManifest; destroyed: boolean; invoked: string[]; hookCalls: boolean[] }> = [];
    let diagnostic: ((value: ScriptRuntimeDiagnostic) => void) | undefined;
    const createFrame: ScriptRuntimeFrameFactory = (_document, _mount, onDiagnostic) => {
      diagnostic = onDiagnostic;
      const frame = {
        destroyed: false,
        invoked: [] as string[],
        hookCalls: [] as boolean[],
        manifest: undefined as TrustedScriptManifest | undefined,
        async start(manifest: TrustedScriptManifest) { frame.manifest = manifest; },
        async invoke(scriptId: string, name: string) { frame.invoked.push(`${scriptId}:${name}`); return true; },
        async runPromptHook(candidate: Parameters<ScriptRuntimeFrame['runPromptHook']>[0], dryRun: boolean) {
          frame.hookCalls.push(dryRun);
          return {
            messages: candidate.messages?.map((message) => ({ ...message, content: `${message.content}-hooked` })),
            text: candidate.text === undefined ? undefined : `${candidate.text}-hooked`, stop: [...candidate.stop, 'HOOK'],
          };
        },
        destroy() { frame.destroyed = true; },
      };
      frames.push(frame);
      return frame;
    };
    const user = userEvent.setup();
    const { queryClient } = renderWithApp(<TrustedScriptRuntimeHost conversationId="conversation-1" createFrame={createFrame} />);

    await screen.findByRole('button', { name: 'preset button' });
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]!.manifest?.scripts.map(({ owner }) => owner.kind)).toEqual(['preset', 'character']);
    window.dispatchEvent(new CustomEvent('tavernnext:script-buttons-changed', { detail: {
      scriptId: `preset:${presetId}:preset-script`,
      buttons: [{ name: 'dynamic preset button', visible: true }, { name: 'hidden preset button', visible: false }],
    } }));
    await screen.findByRole('button', { name: 'dynamic preset button' });
    expect(screen.queryByRole('button', { name: 'preset button' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'hidden preset button' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'character button' }));
    expect(frames[0]!.invoked).toEqual([`character:${characterId}:character-script:character button`]);
    await expect(runTrustedPromptHooks({
      kind: 'chat', messages: [{ role: 'user', content: 'input' }], stop: [],
    }, true)).resolves.toEqual({
      messages: [{ role: 'user', content: 'input-hooked' }], text: undefined, stop: ['HOOK'],
    });
    expect(frames[0]!.hookCalls).toEqual([true]);

    presetDigest = 'c'.repeat(64);
    await queryClient.invalidateQueries({ queryKey: ['extension-trust', 'preset'] });
    await waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[0]!.destroyed).toBe(true);

    characterTrusted = false;
    await queryClient.invalidateQueries({ queryKey: ['extension-trust', 'character'] });
    await waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]!.manifest?.scripts.map(({ owner }) => owner.kind)).toEqual(['preset']);

    diagnostic?.({ scriptId: `preset:${presetId}:preset-script`, scriptName: 'preset script', message: 'boom' });
    expect((await screen.findByRole('alert')).textContent).toContain('preset script');
    expect((screen.getByRole('button', { name: 'preset button' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
