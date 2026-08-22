import type { RegexRunResult } from './regex.js';
import type { RegexWorkerFactory, RegexWorkerReply, RegexWorkerRequest } from './worker-runtime.js';

export const createBrowserRegexWorker: RegexWorkerFactory = (request: RegexWorkerRequest) => {
  const worker = new Worker(new URL('./regex-worker-browser.js', import.meta.url), { type: 'module' });
  const result = new Promise<RegexRunResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<RegexWorkerReply>) => {
      if (event.data.ok && event.data.result !== undefined) resolve(event.data.result);
      else reject(new Error(event.data.error ?? 'regex_worker_error'));
    };
    worker.onerror = () => reject(new Error('regex_worker_error'));
  });
  worker.postMessage(structuredClone(request));
  return { result, terminate: () => worker.terminate() };
};
