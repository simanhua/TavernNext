const RUNTIME_CHANNEL = 'tavernnext-scene-runtime-v2';

export type SceneRuntimeSignal =
  | { type: 'focus'; conversationId: string }
  | { type: 'save.changed'; sceneId: string; conversationId: string };

export function sceneSetupWindowName(sceneId: string): string {
  return `tavernnext-scene-setup-${sceneId}`;
}

export function sceneSaveWindowName(conversationId: string): string {
  return `tavernnext-scene-save-${conversationId}`;
}

export function openSceneWindow(url: string, name: string): Window | null {
  const target = window.open('', name);
  if (target === null) return null;
  try {
    const current = new URL(target.location.href);
    const expected = new URL(url, window.location.href);
    if (current.origin !== expected.origin || current.pathname !== expected.pathname || current.search !== expected.search) {
      target.location.replace(expected.href);
    }
  } catch {
    target.location.href = url;
  }
  target.focus();
  return target;
}

export function sceneRuntimeChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(RUNTIME_CHANNEL);
}

export function announceSceneChanged(sceneId: string, conversationId: string): void {
  const channel = sceneRuntimeChannel();
  channel?.postMessage({ type: 'save.changed', sceneId, conversationId } satisfies SceneRuntimeSignal);
  channel?.close();
}
