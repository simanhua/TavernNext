import { describe, expect, it } from 'vitest';
import { SceneModuleHost } from '../src/scenes/scene-module-host.js';

function moduleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

describe('Scene server module runtime isolation', () => {
  it('invokes a trusted hook in its Worker Thread', async () => {
    const host = new SceneModuleHost(moduleUrl('export default { handleAction(input) { return { result: input.action }; } }'));
    await expect(host.call('handleAction', { action: { type: 'ping' } })).resolves.toEqual({ result: { type: 'ping' } });
    await host.close();
  });

  it('terminates a timed-out Worker without presenting it as a security sandbox', async () => {
    const host = new SceneModuleHost(moduleUrl('export default { beforeGeneration() { return new Promise(() => {}); } }'), 30);
    await expect(host.call('beforeGeneration', {})).rejects.toThrow('scene_hook_timeout');
    await host.close();
  });

  it('contains a Worker crash and rejects its pending hook', async () => {
    const host = new SceneModuleHost(moduleUrl('export default { handleAction() { process.exit(7); } }'));
    await expect(host.call('handleAction', {})).rejects.toThrow('scene_worker_exited');
    await host.close();
  });
});
