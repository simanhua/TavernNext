import { Worker } from 'node:worker_threads';

export type SceneHookName = 'initializeConversation' | 'beforeGeneration' | 'afterGeneration' | 'handleAction';

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
    const value = typeof hook === 'function' ? await hook(structuredClone(message.input)) : {};
    parentPort.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SceneModuleHost {
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, PendingCall>();

  constructor(private readonly moduleUrl: string, private readonly timeoutMs = 10_000) {}

  private start(): Worker {
    if (this.worker !== undefined) return this.worker;
    const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl: this.moduleUrl } });
    worker.on('message', (message: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }) => {
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'scene_hook_failed'));
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
    };
    worker.on('error', (error) => failed(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', (code) => {
      if (code !== 0) failed(new Error('scene_worker_exited'));
      else if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  call<T>(hook: SceneHookName, input: unknown): Promise<T> {
    const worker = this.start();
    const id = this.sequence += 1;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        void worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        reject(new Error('scene_hook_timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      worker.postMessage({ id, hook, input });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) await worker.terminate();
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
