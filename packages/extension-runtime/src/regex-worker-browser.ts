/// <reference lib="webworker" />
import { runRegexScripts } from './regex.js';
import type { RegexWorkerRequest } from './worker-runtime.js';

self.onmessage = (event: MessageEvent<RegexWorkerRequest>) => {
  try {
    self.postMessage({ ok: true, result: runRegexScripts(event.data.raw, [event.data.script], event.data.context) });
  } catch (cause) {
    self.postMessage({ ok: false, error: cause instanceof Error ? cause.message : 'regex_worker_error' });
  }
};
