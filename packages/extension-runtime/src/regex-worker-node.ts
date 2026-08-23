import { parentPort, workerData } from 'node:worker_threads';
import { runRegexScripts } from './regex.js';
import type { RegexWorkerRequest } from './worker-runtime.js';

const request = workerData as RegexWorkerRequest;
try {
  parentPort?.postMessage({ ok: true, result: runRegexScripts(request.raw, [request.script], request.context) });
} catch (cause) {
  parentPort?.postMessage({ ok: false, error: cause instanceof Error ? cause.message : 'regex_worker_error' });
}
