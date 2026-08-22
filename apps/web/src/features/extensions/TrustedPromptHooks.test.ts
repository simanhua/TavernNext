// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { runTrustedPromptHooks, type TrustedPromptHookRequest } from './TrustedPromptHooks.js';

describe('trusted prompt hook orchestration', () => {
  it('times out a non-settling hook and honors cancellation', async () => {
    const hang = (event: Event) => { (event as CustomEvent<TrustedPromptHookRequest>).detail.handled = true; };
    window.addEventListener('tavernnext:run-prompt-hooks', hang);
    await expect(runTrustedPromptHooks({ kind: 'chat', messages: [], stop: [] }, false, { timeoutMs: 5 }))
      .rejects.toThrow('prompt_hook_timeout');
    window.removeEventListener('tavernnext:run-prompt-hooks', hang);

    const controller = new AbortController();
    controller.abort();
    await expect(runTrustedPromptHooks({ kind: 'text', text: 'x', stop: [] }, false, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
