import { Worker } from 'node:worker_threads';

export type SceneHookName = 'initializeConversation' | 'beforeGeneration' | 'afterGeneration'
  | 'handleAction' | 'executeAgentTool';

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
let loaded;
async function moduleValue(){
  loaded ??= import(workerData.moduleUrl).then(value => value.default ?? value);
  return loaded;
}
parentPort.on('message', async message => {
  try {
    const scene = await moduleValue();
    const hook = scene[message.hook];
    if (message.hook === 'executeAgentTool' && typeof hook !== 'function') {
      throw new Error('scene_agent_tool_hook_missing');
    }
    const value = typeof hook === 'function' ? await hook(structuredClone(message.input)) : {};
    parentPort.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface PendingCall {
  worker: Worker;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

export class SceneModuleHost {
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, PendingCall>();

  constructor(private readonly moduleUrl: string, private readonly timeoutMs = 10_000) {}

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker === worker) this.worker = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.removeAbort?.();
      pending.reject(error);
    }
  }

  private start(): Worker {
    if (this.worker !== undefined) return this.worker;
    const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl: this.moduleUrl } });
    worker.on('message', (message: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }) => {
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      pending.removeAbort?.();
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'scene_hook_failed'));
    });
    worker.on('error', (error) => this.failWorker(
      worker,
      error instanceof Error ? error : new Error(String(error)),
    ));
    worker.on('exit', (code) => {
      if (this.worker === worker || [...this.pending.values()].some((pending) => pending.worker === worker)) {
        this.failWorker(worker, new Error(code === 0 ? 'scene_worker_closed' : 'scene_worker_exited'));
      }
    });
    this.worker = worker;
    return worker;
  }

  call<T>(hook: SceneHookName, input: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('scene_hook_aborted'));
    const worker = this.start();
    const id = this.sequence += 1;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        void worker.terminate();
        this.failWorker(worker, new Error('scene_hook_timeout'));
      }, this.timeoutMs);
      const abort = () => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        void worker.terminate();
        this.failWorker(worker, new Error('scene_hook_aborted'));
      };
      const pending: PendingCall = {
        worker,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      };
      this.pending.set(id, pending);
      if (signal !== undefined) {
        pending.removeAbort = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
      if (!this.pending.has(id)) return;
      worker.postMessage({ id, hook, input });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      this.failWorker(worker, new Error('scene_worker_closed'));
      await worker.terminate();
    }
  }
}

export class SceneModuleRegistry {
  private readonly hosts = new Map<string, SceneModuleHost>();

  get(sceneId: string, moduleUrl: string): SceneModuleHost {
    const existing = this.hosts.get(sceneId);
    if (existing !== undefined) return existing;
    const host = new SceneModuleHost(moduleUrl);
    this.hosts.set(sceneId, host);
    return host;
  }

  async remove(sceneId: string): Promise<void> {
    const host = this.hosts.get(sceneId);
    this.hosts.delete(sceneId);
    await host?.close();
  }

  async close(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((host) => host.close()));
    this.hosts.clear();
  }
}
