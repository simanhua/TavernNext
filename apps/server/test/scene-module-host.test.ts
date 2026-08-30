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

  it('aborts the bounded Agent-tool hook and starts a clean Worker afterward', async () => {
    const host = new SceneModuleHost(moduleUrl(`export default {
      executeAgentTool(input) {
        if (input.toolName === 'hang') return new Promise(() => {});
        input.workspace.state.value = 99;
        return { content: 'ok', detail: input };
      }
    }`), 5_000);
    const controller = new AbortController();
    const pending = host.call('executeAgentTool', {
      toolName: 'hang', workspace: { state: { value: 1 } },
    }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('scene_hook_aborted');
    const original = { toolName: 'read', workspace: { state: { value: 1 } } };
    await expect(host.call<{ detail: typeof original }>('executeAgentTool', original)).resolves.toMatchObject({
      content: 'ok', detail: { workspace: { state: { value: 99 } } },
    });
    expect(original.workspace.state.value).toBe(1);
    await host.close();
  });

  it('fails a declared Agent tool when its dedicated Worker hook is missing', async () => {
    const host = new SceneModuleHost(moduleUrl('export default { beforeGeneration() { return {}; } }'));
    await expect(host.call('executeAgentTool', { toolName: 'missing' }))
      .rejects.toThrow('scene_agent_tool_hook_missing');
    await expect(host.call('projectSceneView', { kind: 'missing' }))
      .rejects.toThrow('scene_view_projection_hook_missing');
    await expect(host.call('beforeGeneration', {})).resolves.toEqual({});
    await host.close();
  });
});
