import type { GenerationCandidateTransport, TrustedPromptPatch } from '@tavernnext/domain';

export type TrustedPromptCandidate = Pick<GenerationCandidateTransport, 'kind' | 'messages' | 'text' | 'stop'>;
export type { TrustedPromptPatch } from '@tavernnext/domain';

export interface TrustedPromptHookRequest {
  candidate: TrustedPromptCandidate;
  dryRun: boolean;
  handled: boolean;
  resolve(value: TrustedPromptPatch): void;
  reject(cause: unknown): void;
}

export function runTrustedPromptHooks(
  candidate: TrustedPromptCandidate,
  dryRun: boolean,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TrustedPromptPatch> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); callback();
    };
    const abort = () => finish(() => reject(new DOMException('Prompt hook aborted', 'AbortError')));
    const timeout = setTimeout(() => finish(() => reject(new Error('prompt_hook_timeout'))), options.timeoutMs ?? 10_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted === true) { abort(); return; }
    const detail: TrustedPromptHookRequest = {
      candidate, dryRun, handled: false,
      resolve: (value) => finish(() => resolve(value)),
      reject: (cause) => finish(() => reject(cause)),
    };
    window.dispatchEvent(new CustomEvent('tavernnext:run-prompt-hooks', { detail }));
    if (!detail.handled) detail.resolve(structuredClone({ messages: candidate.messages, text: candidate.text, stop: candidate.stop }));
  });
}
