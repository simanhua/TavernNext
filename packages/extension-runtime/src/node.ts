import { Worker } from 'node:worker_threads';
import type { RegexRunResult } from './regex.js';
import type { RegexWorkerFactory, RegexWorkerReply, RegexWorkerRequest } from './worker-runtime.js';

export const createNodeRegexWorker: RegexWorkerFactory = (request: RegexWorkerRequest) => {
  const worker = new Worker(new URL('./regex-worker-node.js', import.meta.url), {
    workerData: structuredClone(request),
  });
  return {
    result: new Promise<RegexRunResult>((resolve, reject) => {
      worker.once('message', (reply: RegexWorkerReply) => {
        if (reply.ok && reply.result !== undefined) resolve(reply.result);
        else reject(new Error(reply.error ?? 'regex_worker_error'));
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`regex_worker_exit_${code}`));
      });
    }),
    terminate: async () => { await worker.terminate(); },
  };
};
